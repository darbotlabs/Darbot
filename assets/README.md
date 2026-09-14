# Darbot Swarm Solid64 v2.0.0

A production-oriented 64-agent identity pack built from the supplied canonical Darbot assets.

## Fidelity contract

- **Token geometry is source-alpha locked.** Every 2048 px token uses the exact alpha channel from `lmcloud_master_2048_transparent.png`; RGB is replaced with one solid color only.
- **No token contour tracing, path approximation, generative redraw, or morphology is used.**
- Full Darbot agents retain the canonical ghost/visor geometry from the supplied 2048 px logo. The old chest region is cleared and the exact token mask is placed at `[768, 984, 1280, 1513]` on the 2048 px canvas.
- Status dots and visor interior are preserved from the canonical full logo.
- All 64 colors are unique and map one-to-one to the 64 agent perspectives.

## Source hashes

- Full Darbot logo SHA-256: `c888224ba1bd3a961794f34896cd31fcb325d892b768abd2b64e76c0f314cc44`
- Exact token master SHA-256: `f177188e829b54313f6b502f6769aa9f6ab93bdf92a54ffd0b5e065d319858d2`
- Exact token alpha SHA-256: `85b34e4b08a648f642520d745a0834c0bd95ff807b4564d18f515501438fd133`

## Palette construction

The palette contains 64 solid sRGB tokens. Eight named anchors are connected in **OKLab**, using nine equal intervals per segment. This yields exactly 64 samples and places anchors at indices 1, 10, 19, 28, 37, 46, 55, and 64.

| Index | Anchor | Hex |
|---:|---|---|
| 1 | Nitrous Blue | `#00CFFF` |
| 10 | Cobalt Blue | `#0047AB` |
| 19 | Magenta | `#FF00D4` |
| 28 | Competition Orange | `#FF5A00` |
| 37 | Lava | `#C51A0B` |
| 46 | Banana Yellow | `#FFE135` |
| 55 | Candyapple Red | `#FF0800` |
| 64 | Frost White | `#F4FBFF` |

The color names are Darbot canonical design-token names, not claims about official Microsoft product colors or automotive paint specifications.

## Unicode / terminal color

Unicode characters do not carry arbitrary RGB values. The manifest therefore pairs the swatch character `■` (`U+25A0`) with ANSI truecolor foreground/background sequences. Each entry also includes the nearest xterm-256 fallback.

Example for DSW64-01:

```text
\u001b[38;2;0;207;255m■\u001b[0m
```

## Key outputs

- `manifest/darbot_swarm_agent_perspectives.v2.json` — canonical schema mapping.
- `manifest/darbot_swarm_agent_perspectives.schema.json` — JSON Schema.
- `manifest/darbot_swarm_agent_perspectives.v2.csv` — flattened inventory.
- `bindings/` — CSS, TypeScript, C#, Power Fx, and GIMP palette bindings.
- `tokens/` — 2048/1024/512/256 transparent PNGs, 1024 dark tiles, and SVG exact-raster-mask wrappers.
- `agents/` — full Darbot agent exports at 2048/1024/512 plus transparent 1024 variants.
- `contact_sheets/` — palette, token, and full-agent reviews.
- `html/darbot_swarm_solid64_gallery.html` — searchable local gallery.
- `qa/` — source-lock comparison and machine-readable QA report.

## QA summary

- Variants: **64**
- Unique hex codes: **64**
- 2048 token alpha mismatches: **0**
- Maximum 2048 token alpha delta: **0**
- Token geometry drift: **0 pixels**
- Shared chest placement: `[768, 984, 1280, 1513]`

## Recommended schema key

Use `agent_id` as the stable semantic identifier and `color.token_id` as the stable visual identifier. Do not key business logic directly from display names or raw hex values.
