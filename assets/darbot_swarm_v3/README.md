# Darbot Swarm — Mint / Opal 64

**Release 3.0.0 · Series 02 · Swarm indices 65–128**

A second cohort of 64 source-locked Darbot identities: the 15 requested framework/interaction IDs plus 49 proposed domain specialists. The earlier Solid64 cohort and its IDs are not overwritten. This package contains visual identities, proposed perspectives and registry bindings—not running or connected agents.

## Start here

Open `html/darbot_mint_opal_gallery.html`. It embeds all 64 agent/token previews and the registry. No CDN, server, external images or package installation is required for the gallery. Search, filter by domain or finish, switch agent/token views, inspect an identity, save a 512px preview, or export the registry JSON.

The contact sheets are in `contact_sheets/`:

- `all_64_agents.png` — 4096px-wide full-agent sheet.
- `all_64_tokens.png` — matching canonical token sheet.
- `framework_cohort_15.png` — the exact 15 requested IDs.
- `palette_64.png` — palette order, independent of agent order.
- `mint_opal_material_proof.png` — large mint, opal and nitrous token review.

## Color and material system

The eight-anchor system retains nine OKLab intervals between successive anchors, producing 64 unique fallback sRGB colors. The eight anchors are:

| Palette index | Anchor | Solid / fallback hex |
|---:|---|---|
| 1 | Nitrous Blue | `#00CFFF` |
| 10 | Cobalt Blue | `#0047AB` |
| 19 | Magenta | `#FF00D4` |
| 28 | Competition Orange | `#FF5A00` |
| 37 | Lava | `#C51A0B` |
| 46 | Opal Lightning Splatter | `#69CFC2` — fallback only |
| 55 | Mint Green | `#50E6C2` |
| 64 | Frost White | `#F4FBFF` |

**Mint Green replaces the Candyapple Red anchor. Opal Lightning Splatter replaces the Banana Yellow anchor.** The named red/yellow anchors are not retained in this palette. The opal material can still contain warm spectral flecks from the supplied photograph.

The output contains **47 solid fills and 17 graded opal material fills**. Opal intensity rises from palette indices 38–46 and falls from 46–54, reaching pure mint at 55. A single hex triplet cannot describe the opal texture: `visual.material.material_id`, `strength` and the source texture describe its rendering; `fallback_hex` is the deterministic flat-color alternative for terminals or systems without image materials.

The requested cohort is assigned palette entries 50–64, giving it an opal-mint through mint-frost progression. Agent order and palette order are intentionally separate. Adjacent stepped colors are not guaranteed to be visually distinguishable for every observer; use readable names and IDs as well as color.

All color names are Darbot design tokens, not claims about official vendor palettes, standardized paint colors, or safety/trust certification.

## Exact requested IDs and Mint naming

| Exact machine ID | Darbot display alias |
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

The naming convention is **Mint + a distinct, domain-relevant role noun**. `agent-bot` and `agent-computer` remain generic requested roles; they are not silently mapped to a specific vendor SDK. Framework context links are recorded in `manifest/framework-references.json`. All aliases and domain assignments are Darbot-specific, not vendor endorsements.

The other 49 perspectives cover protocol integration, identity, policy, memory, ontologies, knowledge graphs, retrieval, ranking, embeddings, context, schema design, provenance, evaluation, observability, routing, planning, scheduling, replay, isolation, browser/terminal/file operations, networks, storage, inference, quantization, training, reinforcement learning, vision, OCR, speech, robotics, simulation, geospatial systems, API design, data quality, ETL, event streams, interface design, accessibility, technical writing, research, privacy, threat modeling, formal verification, sustainability and swarm coordination.

## Fidelity contract

1. Every 2048px standalone token copies the alpha channel of the supplied `token_original.png` exactly. No contour tracing, vector approximation, morphology or generative redraw is used.
2. The token alpha source bbox is `[96, 65, 1952, 1983]`. It is cropped once and resampled with Lanczos to 512×529 for the shared 2048px full-agent chest bbox `[768, 984, 1280, 1513]`.
3. The ghost/visor outline alpha is recovered from the accepted previous Nitrous solid avatar. The original visor interior and three status dots are retained, without recoloring.
4. The opal texture is made from the user's low-resolution photograph as a chroma reference, plus deterministic spectral bands and seeded fine splatter. It is a designed interpretation, not a high-resolution geological scan. All patterning is clipped to the same fixed alpha shapes.
5. Transparent agent exports retain the outline, original visor/dots and token; the black negative-space body and outside background are transparent.
6. SVG exports are explicitly named **raster-backed wrappers**. They embed the precise token PNG rather than pretending to be editable vector contours.

`qa/render-validation.json` verifies reopened 2048px token alpha, full-agent chest pixels and preserved visor/dot RGB. `qa/independent-validation.json` additionally verifies reopened 1024px full-agent alpha, checksums, schema validity and HSL round trips. These tests do not assert full-image RGB equality: changing RGB is the purpose of the variations.

## Exports

| Asset | Sizes / format |
|---|---|
| Transparent standalone tokens | 2048, 1024, 512, 256px PNG |
| Full agents on black | 2048, 1024, 512px PNG |
| Transparent full agents | 1024, 512, 256px PNG |
| Exact token wrappers | 2048px raster-backed SVG |
| Offline gallery | One self-contained HTML file |
| Registry / schema | JSON, JSON Schema, CSV, Markdown roster |
| Bindings | CSS, TypeScript, C#, Power Fx, design-token JSON, ANSI |
| QA | Source comparison, machine-readable reports, desktop/mobile screenshots |

The full archive contains all 704 individual agent/token exports. The compact archive omits per-agent 2048px PNGs and raster-backed SVG wrappers. It retains the source files, contact sheets, registry, lower-resolution exports, gallery and production tools. The compact package's delivery manifest identifies which registry asset paths are actually included; the full master registry remains unchanged for stable references.

## Identity and schema mapping

Use `agent_id` for the exact semantic machine identifier. `identity_code` is the extension-scoped visual identity code (`DSW-MO-065` through `DSW-MO-128`). `swarm_index` is the proposed append-only global slot. `palette_token` identifies the color/material sample independently.

Do not route execution or authorize actions by raw color. No claim is made that the 128-persona combined fleet has 128 unique colors; this extension intentionally reuses existing blue/magenta/orange/lava families. Its 64 fallback hex values are unique within the new cohort.

Unicode does not itself assign arbitrary RGB colors. The registry uses `■` (`U+25A0`) with ANSI truecolor sequences, consistent with the user-supplied ANSI reference: `ESC[38;2;r;g;bm` for foreground and `ESC[48;2;r;g;bm` for background. The xterm-256 fallback searches fixed palette entries 16–255; theme-dependent entries 0–15 are intentionally excluded. Opal uses its single-color fallback in ANSI output.

The HSL field ordering and xterm cube-index problems previously identified in v2 are corrected and tested in this v3 registry. Existing v2 archives have not been silently modified.

## Rebuild and validate

```bash
pip install -r requirements.txt
python tools/build_assets.py --rebuild --workers 4
python tools/publish_pack.py metadata
python tools/publish_pack.py sheets
python tools/publish_pack.py gallery
python tools/publish_pack.py qa
python tools/validate_pack.py
```

For time-limited environments, run the renderer with `--limit 8` and repeat until complete. Use `--rebuild` only on the first invocation, because it clears checkpoints and regenerates the material. Subsequent invocations resume from `qa/entry_state/`. Use `--rebuild` after any source, palette or roster changes; never reuse checkpoints from different inputs.

Asset rendering uses Pillow and NumPy. Metadata validation uses jsonschema. Contact-sheet typography uses an installed Inter font when available and a system fallback otherwise; font files are not distributed. Identity PNG geometry does not depend on fonts.

Gallery behavior was tested in installed Chromium at desktop and mobile dimensions with no external network requests and no JavaScript errors. This environment blocks direct `file:` navigation, so the test loaded the HTML content directly. Safari and Firefox were not separately tested.
