/**
 * Composable sidepane layers.
 *
 * A sidepane is a stack of named layers rather than one hand-written column, so
 * a surface can compose the layers it needs without duplicating the agent
 * navigator, its disclosure behaviour, or the tool rail.
 */

export const SIDEPANE_DISCLOSURE_SCHEMA_VERSION = 1;
export const SIDEPANE_DISCLOSURE_STORAGE_KEY = "darbot:copilot:sidepane";

const MAX_LAYERS = 32;
const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 256;
const MAX_DISCLOSURE_ENTRIES = 512;
const MAX_DISCLOSURE_LENGTH = 200_000;

export const SIDEPANE_REGIONS = ["header", "body", "footer"] as const;

export type SidepaneRegion = (typeof SIDEPANE_REGIONS)[number];

export type SidepaneLayer = {
  /** Stable layer identity. Unique within a sidepane. */
  id: string;
  /** Accessible label for the layer. */
  title: string;
  /** Where the layer sits in the column. */
  region: SidepaneRegion;
  /** Ascending placement within the region. */
  order: number;
  /** Whether the layer renders groups that can be expanded and collapsed. */
  collapsible: boolean;
  /** Whether a collapsible group starts expanded when the user has no saved choice. */
  expandedByDefault: boolean;
};

export type SidepaneSpec = {
  id: string;
  label: string;
  layers: readonly SidepaneLayer[];
};

export type SidepaneLayerInput = {
  id: string;
  title: string;
  region: SidepaneRegion;
  order?: number;
  collapsible?: boolean;
  expandedByDefault?: boolean;
};

export type SidepaneSpecInput = {
  id: string;
  label: string;
  layers: readonly SidepaneLayerInput[];
};

/** Persisted, explicit user disclosure choices keyed by group. */
export type SidepaneDisclosure = {
  schemaVersion: typeof SIDEPANE_DISCLOSURE_SCHEMA_VERSION;
  /** Only groups the user has toggled appear here; everything else follows the layer default. */
  groups: Record<string, boolean>;
};

type DisclosureStorage = Pick<Storage, "getItem" | "setItem">;

function identifier(value: string, label: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new Error(`${label} must be between 1 and ${max} characters.`);
  }
  return trimmed;
}

export function emptySidepaneDisclosure(): SidepaneDisclosure {
  return { schemaVersion: SIDEPANE_DISCLOSURE_SCHEMA_VERSION, groups: {} };
}

/**
 * Validates a sidepane description and returns it with layers ordered by region
 * and then by explicit order, so callers render a stable column.
 */
export function defineSidepane(spec: SidepaneSpecInput): SidepaneSpec {
  const id = identifier(spec.id, "Sidepane ID", MAX_ID_LENGTH);
  const label = identifier(spec.label, "Sidepane label", MAX_TITLE_LENGTH);
  if (!spec.layers.length || spec.layers.length > MAX_LAYERS) {
    throw new Error(
      `Sidepane must declare between 1 and ${MAX_LAYERS} layers.`,
    );
  }
  const seen = new Set<string>();
  const layers = spec.layers.map((layer, index) => {
    const layerId = identifier(layer.id, "Sidepane layer ID", MAX_ID_LENGTH);
    if (seen.has(layerId)) {
      throw new Error(
        `Sidepane layer "${layerId}" is declared more than once.`,
      );
    }
    seen.add(layerId);
    if (!SIDEPANE_REGIONS.includes(layer.region)) {
      throw new Error(
        `Sidepane layer "${layerId}" must sit in ${SIDEPANE_REGIONS.join(", ")}.`,
      );
    }
    const order = layer.order ?? index;
    if (!Number.isFinite(order)) {
      throw new Error(`Sidepane layer "${layerId}" needs a finite order.`);
    }
    const collapsible = layer.collapsible ?? false;
    const expandedByDefault = layer.expandedByDefault ?? false;
    if (expandedByDefault && !collapsible) {
      throw new Error(
        `Sidepane layer "${layerId}" cannot default to expanded without being collapsible.`,
      );
    }
    return {
      id: layerId,
      title: identifier(layer.title, "Sidepane layer title", MAX_TITLE_LENGTH),
      region: layer.region,
      order,
      collapsible,
      expandedByDefault,
    } satisfies SidepaneLayer;
  });
  layers.sort(
    (left, right) =>
      SIDEPANE_REGIONS.indexOf(left.region) -
        SIDEPANE_REGIONS.indexOf(right.region) || left.order - right.order,
  );
  return { id, label, layers };
}

export function sidepaneRegion(
  spec: SidepaneSpec,
  region: SidepaneRegion,
): SidepaneLayer[] {
  return spec.layers.filter((layer) => layer.region === region);
}

export function sidepaneLayer(
  spec: SidepaneSpec,
  layerId: string,
): SidepaneLayer {
  const layer = spec.layers.find((candidate) => candidate.id === layerId);
  if (!layer) {
    throw new Error(`Sidepane "${spec.id}" has no layer "${layerId}".`);
  }
  return layer;
}

/** Namespaces a group key so two layers never share disclosure state. */
export function sidepaneGroupKey(layerId: string, groupId: string): string {
  return `${layerId}:${groupId}`;
}

/**
 * Resolves whether a group is open. An explicit user choice always wins;
 * otherwise the group follows the layer default, and an active group is opened
 * so the current selection is never hidden behind a collapsed arrow.
 */
export function isSidepaneGroupExpanded(
  disclosure: SidepaneDisclosure,
  layer: SidepaneLayer,
  groupId: string,
  active = false,
): boolean {
  if (!layer.collapsible) return true;
  const stored = disclosure.groups[sidepaneGroupKey(layer.id, groupId)];
  if (typeof stored === "boolean") return stored;
  return layer.expandedByDefault || active;
}

/** Records an explicit choice, dropping the oldest entries past the bound. */
export function setSidepaneGroupExpanded(
  disclosure: SidepaneDisclosure,
  layer: SidepaneLayer,
  groupId: string,
  expanded: boolean,
): SidepaneDisclosure {
  if (!layer.collapsible) return disclosure;
  const key = sidepaneGroupKey(layer.id, groupId);
  const entries = Object.entries(disclosure.groups).filter(
    ([candidate]) => candidate !== key,
  );
  entries.push([key, expanded]);
  return {
    schemaVersion: SIDEPANE_DISCLOSURE_SCHEMA_VERSION,
    groups: Object.fromEntries(entries.slice(-MAX_DISCLOSURE_ENTRIES)),
  };
}

export function validateSidepaneDisclosure(value: unknown): SidepaneDisclosure {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Saved sidepane layout must be an object.");
  }
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).some((key) => !["schemaVersion", "groups"].includes(key))
  ) {
    throw new Error("Saved sidepane layout contains unsupported fields.");
  }
  if (data.schemaVersion !== SIDEPANE_DISCLOSURE_SCHEMA_VERSION) {
    throw new Error(
      "Unsupported sidepane layout version. Use the Darbot version that saved it.",
    );
  }
  if (
    !data.groups ||
    typeof data.groups !== "object" ||
    Array.isArray(data.groups)
  ) {
    throw new Error("Saved sidepane groups must be an object.");
  }
  const entries = Object.entries(data.groups as Record<string, unknown>);
  if (entries.length > MAX_DISCLOSURE_ENTRIES) {
    throw new Error(
      `Saved sidepane layout must contain at most ${MAX_DISCLOSURE_ENTRIES} groups.`,
    );
  }
  const groups: Record<string, boolean> = {};
  for (const [key, expanded] of entries) {
    if (!key || key.length > MAX_ID_LENGTH * 2 + 1) {
      throw new Error("Saved sidepane group keys are invalid.");
    }
    if (typeof expanded !== "boolean") {
      throw new Error(`Saved sidepane group "${key}" must be true or false.`);
    }
    groups[key] = expanded;
  }
  return { schemaVersion: SIDEPANE_DISCLOSURE_SCHEMA_VERSION, groups };
}

/** Reads saved disclosure state, falling back to defaults rather than failing the surface. */
export function readSidepaneDisclosure(
  storage?: DisclosureStorage,
): SidepaneDisclosure {
  try {
    const raw = (storage ?? window.localStorage).getItem(
      SIDEPANE_DISCLOSURE_STORAGE_KEY,
    );
    if (raw === null) return emptySidepaneDisclosure();
    if (raw.length > MAX_DISCLOSURE_LENGTH) return emptySidepaneDisclosure();
    return validateSidepaneDisclosure(JSON.parse(raw));
  } catch {
    return emptySidepaneDisclosure();
  }
}

export function writeSidepaneDisclosure(
  disclosure: SidepaneDisclosure,
  storage?: DisclosureStorage,
): void {
  const serialized = JSON.stringify(validateSidepaneDisclosure(disclosure));
  if (serialized.length > MAX_DISCLOSURE_LENGTH) {
    throw new Error("The sidepane layout exceeds the supported storage size.");
  }
  (storage ?? window.localStorage).setItem(
    SIDEPANE_DISCLOSURE_STORAGE_KEY,
    serialized,
  );
}

/** The sidepane composed by the Copilot workspace. */
export const COPILOT_WORKSPACE_SIDEPANE = defineSidepane({
  id: "copilot-workspace",
  label: "Agents and chats",
  layers: [
    { id: "brand", title: "Darbot", region: "header", order: 0 },
    { id: "compose", title: "Start work", region: "header", order: 1 },
    {
      id: "agents",
      title: "Agents",
      region: "body",
      order: 0,
      collapsible: true,
      expandedByDefault: false,
    },
    { id: "tools", title: "Workspace tools", region: "footer", order: 0 },
  ],
});

export const SIDEPANE_AGENT_LAYER = sidepaneLayer(
  COPILOT_WORKSPACE_SIDEPANE,
  "agents",
);
