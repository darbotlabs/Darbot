# GPT Cowork Handoff — Integrate Darbot Swarm Identity Assets + Agent Perspectives

You are working on the user's **local build of `github.com/darbotlabs/darbot`**, expected at:

```text
E:\Darbot
```

Your job is to inspect the local repository first, then integrate the approved Darbot Swarm identity assets and schema mappings throughout the product without breaking existing behavior.

## Operating principles

1. **Treat the local repository as the source of truth.** Do not assume the public GitHub tree exactly matches the local build.
2. **Do not mass-replace strings or blindly overwrite existing assets/configuration.** Audit references and integrate intentionally.
3. **Preserve all existing agent machine IDs.** In particular, preserve these exact IDs verbatim:
   - `agent-adk`
   - `agent-ag2`
   - `agent-agno`
   - `agent-bot`
   - `agent-claude-sdk`
   - `agent-computer`
   - `agent-crewai`
   - `agent-langgraph`
   - `agent-langgraph-agui`
   - `agent-langroid`
   - `agent-llamaindex`
   - `agent-mastra`
   - `agent-microsoft`
   - `agent-pydantic-ai`
   - `agent-strands`
4. **Visual fidelity is non-negotiable.** Do not redraw, trace, morph, simplify, or approximate the Darbot token geometry. Use the packaged, source-locked raster assets and their manifests.
5. **Preserve canonical Darbot geometry:** ghost silhouette, visor, status dots, and segmented cloud/circuit lightning token.
6. **Color/material identity is metadata, not authorization.** Never route privileged behavior, permissions, or trust decisions from raw color values.
7. **Opal Lightning Splatter is a material, not a single RGB color.** Use its material metadata where the UI can render the artwork; use its fallback hex only where a flat scalar color is mandatory.
8. Keep implementation modular and reversible. Prefer a central asset/identity registry over scattered hard-coded imports.
9. Do not delete existing user-created agents, channels, credentials, boundaries, skills, or local configuration.
10. Before committing changes, run the repository's existing lint/typecheck/test/build workflows and report any pre-existing failures separately from regressions.

---

# Handoff contents

The folder containing this prompt includes two approved cohorts:

## Cohort 01 — Solid64 v2

- Swarm perspectives 1–64.
- 64 unique solid sRGB token identities.
- Exact source-alpha-locked token geometry.
- Full-resolution package included as `cohorts/darbot_swarm_solid64_v2_full.zip`.
- Canonical mapping uses stable semantic `agent_id` plus stable visual `color.token_id`.

Historical anchor sequence:

```text
Nitrous Blue -> Cobalt Blue -> Magenta -> Competition Orange -> Lava -> Banana Yellow -> Candyapple Red -> Frost White
```

This is **Cohort 01 history**. Do not retroactively recolor or mutate it unless the local product deliberately aliases old themes to the newer system.

## Cohort 02 — Mint / Opal 64 v3

- Swarm indices 65–128.
- Contains the exact 15 requested framework/interaction IDs plus 49 domain specialists.
- Packaged as `cohorts/darbot_swarm_mint_opal64_v3_compact.zip`.
- This compact distribution contains production-ready 1024/512/256 assets, registries, contact sheets, source assets, QA artifacts, and the deterministic rebuild tools.
- If the local implementation needs 2048 masters or raster-backed SVG wrappers, run the packaged rebuild tooling locally rather than fabricating replacements.

Current anchor sequence:

```text
Nitrous Blue -> Cobalt Blue -> Magenta -> Competition Orange -> Lava -> Opal Lightning Splatter -> Mint Green -> Frost White
```

Canonical Mint Green:

```text
#50E6C2
```

Opal Lightning fallback where a scalar color is unavoidable:

```text
#69CFC2
```

### Requested framework identities

Preserve machine IDs exactly and use these Darbot display aliases unless the local repo already has a user-edited display name that should be retained:

| Machine ID | Darbot alias |
|---|---|
| `agent-adk` | Mint Seed |
| `agent-ag2` | Mint Council |
| `agent-agno` | Mint Grove |
| `agent-bot` | Mint Relay |
| `agent-claude-sdk` | Mint Forge |
| `agent-computer` | Mint Pilot |
| `agent-crewai` | Mint Crew |
| `agent-langgraph` | Mint Branch |
| `agent-langgraph-agui` | Mint Stream |
| `agent-langroid` | Mint Dialog |
| `agent-llamaindex` | Mint Index |
| `agent-mastra` | Mint Flow |
| `agent-microsoft` | Mint Mesh |
| `agent-pydantic-ai` | Mint Contract |
| `agent-strands` | Mint Thread |

---

# Local integration objective

Integrate these identity assets into `E:\Darbot` so the product can consistently resolve:

```text
agent identity -> perspective metadata -> palette/material token -> avatar/token assets
```

The result should be usable across every UI surface that represents an agent/coworker without duplicating identity logic.

## Preferred destination

Use the existing repository convention if one already exists. Otherwise create a structure along these lines:

```text
E:\Darbot\assets\darbot-swarm\
  canonical\
  cohort-01-solid64\
  cohort-02-mint-opal64\
  manifests\
  generated\
```

Do **not** create redundant copies in many application directories. Application code should import/resolve the central registry and canonical asset roots.

---

# Phase 1 — Inspect before changing anything

From `E:\Darbot`, determine:

1. Git status, branch, and current uncommitted changes.
2. Workspace/package layout.
3. Existing `assets/`, `public/`, icon/avatar directories, static-file serving rules, and build-copy rules.
4. Existing references to:
   - `agents.yaml`
   - agent definitions / coworker definitions
   - `/agents`
   - avatars/icons/profile images
   - `agent-*` framework directories
   - AG-UI registration
   - agent metadata schemas/types
   - seed/example tenant data
5. Whether asset paths are persisted to PostgreSQL, generated at runtime, or resolved from configuration.
6. Whether the UI accepts URLs, static paths, data URIs, or imported modules for avatars.
7. Existing tests/snapshots that cover agent cards, lists, channels, composer mentions, `/bot`, admin screens, or agent selection.

Print a concise integration plan before editing.

---

# Phase 2 — Stage and verify assets

1. Copy/extract the approved packages into the chosen central asset directory.
2. Preserve the package manifests and `SHA256SUMS.txt` files.
3. Verify checksums before wiring anything into the application.
4. Keep the canonical source artifacts available for regression comparison.
5. Do not use the older `darbot_swarm_color_variations_v1` set if it appears anywhere. It is superseded by Solid64 v2 and Mint/Opal64 v3.

Canonical visual contract:

- Token geometry is source-alpha locked.
- No contour tracing, path approximation, generative redraw, morphology, or freehand SVG reconstruction.
- Shared full-agent chest placement is defined by the manifests.
- Visor and status dots remain canonical and should not be silently recolored.

---

# Phase 3 — Build a single identity registry adapter

Do not make application components understand the raw package formats independently.

Create or extend one typed registry layer that can resolve, at minimum:

```ts
interface DarbotAgentIdentity {
  agentId: string;
  identityCode: string;
  swarmIndex: number;
  displayName: string;
  domain?: string;
  role?: string;
  perspective?: string;
  cohort: "solid64" | "mint-opal64";
  paletteToken: string;
  fallbackHex: string;
  material?: {
    kind: "solid" | "material";
    materialId?: string | null;
    strength?: number;
  };
  avatar: {
    png1024?: string;
    png512?: string;
    png256?: string;
    transparent1024?: string;
    transparent512?: string;
  };
  token: {
    png1024?: string;
    png512?: string;
    png256?: string;
  };
}
```

Adapt this shape to the repo's conventions instead of forcing the exact interface if a suitable model already exists.

Requirements:

- Preserve `agent_id` as the semantic/machine identity.
- Preserve `identity_code` / swarm index independently from the machine ID.
- Preserve palette/material token independently from both.
- Allow graceful fallback for agents not in either registry.
- Avoid import-time loading of hundreds of large PNGs into client bundles. Prefer stable public/static URLs or lazy resolution according to the existing framework.

---

# Phase 4 — Map existing framework agents

Inspect each existing framework directory and bind it to its exact registry identity where appropriate:

```text
agent-adk
agent-ag2
agent-agno
agent-bot
agent-claude-sdk
agent-computer
agent-crewai
agent-langgraph
agent-langgraph-agui
agent-langroid
agent-llamaindex
agent-mastra
agent-microsoft
agent-pydantic-ai
agent-strands
```

Important:

- Do not rename the directories merely to match display aliases.
- Do not change protocol behavior just to integrate branding.
- Do not infer SDK compatibility from a display alias.
- If an agent directory already carries metadata/configuration, extend it minimally or resolve visuals externally through the registry.

---

# Phase 5 — Apply throughout relevant UI surfaces

Search the local repo and update applicable visual surfaces, including where present:

- agent/coworker cards on `/agents`
- channel list and channel header
- agent picker / bot picker
- `/bot?agent=<id>` identity surfaces
- activity panes
- agent detail/editor views
- admin/computer lists where agent identity is shown
- mentions / chips / badges
- empty states or onboarding examples that depict specific agents
- seed/example coworker definitions
- any generated OpenGraph/demo cards that intentionally display an agent

Do not replace unrelated product logos or architecture artwork simply because they contain a generic bot icon.

At small sizes, prefer the standalone token or a dedicated small avatar export if the complete ghost becomes illegible. At larger sizes, prefer the full-agent avatar.

---

# Phase 6 — Schema and semantic integration

Expose perspective metadata as descriptive context where useful, but do not silently inject every perspective into runtime prompts unless the product architecture explicitly supports persona/system-instruction composition.

If runtime persona composition exists:

1. Keep visual identity metadata separate from executable prompt instructions.
2. Add perspective context through the existing typed configuration model.
3. Make changes inspectable and user-editable.
4. Preserve user-defined roles over packaged defaults.
5. Do not make color/material determine behavior.

---

# Phase 7 — Tests and QA

At minimum verify:

### Asset QA
- all referenced files exist;
- no broken URLs/imports;
- transparent assets remain transparent;
- Opal artwork is not flattened unless the target surface requires it;
- canonical token silhouette has not changed.

### Registry QA
- no duplicate `agent_id` within the effective registry;
- no duplicate identity code within a cohort;
- all 15 requested machine IDs resolve;
- all referenced palette/material tokens resolve;
- fallback behavior works for unknown/user-created agents.

### UI QA
- light/dark theme legibility;
- 16/24/32/48/64px small-avatar behavior where used;
- common desktop layout;
- narrow/mobile layout if supported;
- cards/lists do not shift excessively from oversized images;
- accessible alt text / labels use semantic names, not hex codes.

### Engineering QA
Run whatever is defined by the local repo, for example:

```powershell
bun install
bun run lint
bun run typecheck
bun test
bun run build
```

Do not invent commands if the local package scripts differ: inspect first.

---

# Phase 8 — Final report

When finished, report:

1. Exact files/directories added.
2. Exact source files modified.
3. Which UI surfaces now consume Darbot identities.
4. Which of the 128 identities are actively mapped to existing runnable agents versus available as perspective assets only.
5. Any registry collisions or ambiguities discovered.
6. Test/lint/typecheck/build results.
7. Screenshots or local routes for reviewing the integration.
8. Remaining work, if any.

Do not claim all 128 are executable agents merely because 128 identity/perspective definitions exist. The asset packs define visual identities and proposed perspectives; runtime availability depends on the local repository's actual agent implementations and configuration.

---

# Critical visual regression rule

Whenever transforming or exporting these assets, compare the result against the packaged canonical source. If the Darbot silhouette, visor, three status dots, segmented circular geometry, lightning bolt, negative spaces, or chest placement drift, reject the output and restore the source-locked asset.

Professional asset fidelity is more important than convenient approximation.
