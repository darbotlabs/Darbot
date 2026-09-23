# Sidepane layers

The desktop sidepane is described as a stack of named layers rather than one
hand-written column, so a surface can compose the layers it needs without
duplicating the agent navigator, its disclosure behaviour, or the tool rail.

The spec lives in [`desktop/src/sidepane-layers.ts`](../desktop/src/sidepane-layers.ts)
and is covered by `desktop/src/sidepane-layers.test.ts`.

## The contract

A sidepane is an `id`, a `label` used as the column's accessible name, and one
or more layers. Each layer declares:

| Field | Meaning |
| --- | --- |
| `id` | Stable identity, unique within the sidepane. Also namespaces saved disclosure state. |
| `title` | Accessible label for the layer. |
| `region` | `header`, `body`, or `footer`. |
| `order` | Ascending placement within the region. Defaults to declaration order. |
| `collapsible` | Whether the layer renders groups that expand and collapse. |
| `expandedByDefault` | Whether a collapsible group starts open when the person has made no choice. |

`defineSidepane` validates the description and returns the layers sorted by
region and then by `order`, so every surface renders the same stable column.
It rejects duplicate layer IDs, unknown regions, non-finite orders, empty or
oversized identifiers, and a layer that defaults to expanded without being
collapsible. `sidepaneRegion` and `sidepaneLayer` read the result back.

## Composing a sidepane

```ts
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
```

A different sidepane — a canvas inspector, a fleet column — declares its own
layers against the same contract and inherits the same disclosure rules and
persistence. Layers are data, not components: a surface still decides what to
draw inside a layer.

## Disclosure

Most agents run a single conversation, so the `agents` layer collapses its
conversations behind a disclosure arrow. Resolution order in
`isSidepaneGroupExpanded` is:

1. A non-collapsible layer is always open.
2. An explicit saved choice for that group wins, in either direction.
3. Otherwise the group follows `expandedByDefault`, or opens because it is
   active — the group holding the open conversation is never hidden behind a
   collapsed arrow.

`setSidepaneGroupExpanded` records only explicit choices, keyed by
`layerId:groupId` so two layers never collide, and keeps at most 512 entries by
dropping the oldest. Non-collapsible layers record nothing.

## Storage

Disclosure state is saved under `darbot:copilot:sidepane` as
`{ schemaVersion, groups }`. `validateSidepaneDisclosure` rejects unsupported
fields, an unknown schema version, non-boolean values, oversized keys, and more
than 512 groups.

This is presentation state only. `readSidepaneDisclosure` falls back to the
defaults rather than failing the surface when the saved layout is unreadable,
and a failed write leaves the column working — the choice simply does not
survive a restart. Conversations and drafts are unaffected; those live in the
separate workspace store described in
[GitHub Copilot CLI runtime](copilot-cli.md).
