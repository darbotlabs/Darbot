# Darbot Updated Logo — Complete Asset Spec List

Canonical profile: `darbot-ghost-core-emblem-v1`  
Source raster: `50fb8f74-9e75-4dc4-a22a-62bab0a6917a.png`  
Source dimensions: 2048 × 2048 PNG, RGBA, fully opaque black background  
Source SHA-256: `c888224ba1bd3a961794f34896cd31fcb325d892b768abd2b64e76c0f314cc44`

## Visual identity summary

The updated Darbot logo is a high-contrast neon ghost mascot on a black square canvas. It has a magenta-to-cyan glowing outline, a dark indigo browser/agent visor with three status dots, and the updated chest emblem: a segmented globe/circuit disc crossed by a diagonal lightning bolt. The mark should feel autonomous, agentic, cybernetic, friendly, secure, high-energy, and internet-scale.

## Core design tokens

| Token | Hex | Usage |
|---|---:|---|
| Void Black | `#000000` | Primary background |
| Deep Indigo Fill | `#100050` | Visor fill and subtle interior glow |
| Neon Magenta | `#F00EF4` | Left ghost outline and left emblem segments |
| Core Purple | `#9634F9` | Lightning bolt, gradient transitions |
| Agent Blue | `#0FA4F8` | Emblem and stroke transition blue |
| Electric Cyan | `#12D5FB` | Right ghost outline and right emblem segments |
| Status Red | `#F0144F` | Left visor dot |
| Status Cyan | `#02ACF0` | Middle visor dot |
| Status Green | `#1DC46A` | Right visor dot |

## Geometry reference

| Region | Approx. pixel bounds / coordinates |
|---|---|
| Canvas | 2048 × 2048 |
| Visible logo bounds | x 351–1702, y 225–1778; 1352 × 1554 |
| Ghost silhouette | x 351, y 225, w 1352, h 1554 |
| Visor | x 641, y 522, w 777, h 379 |
| Red status dot | center 769, 628; diameter 52 px |
| Cyan status dot | center 851, 628; diameter 52 px |
| Green status dot | center 935, 628; diameter 51 px |
| Updated chest/core emblem | x 773, y 983, w 500, h 543 |
| Globe disc | center 1024, 1250; estimated diameter 500 px |
| Lightning bolt | approx. x 922, y 985, w 326, h 538; diagonal upper-right to lower-left |

## Directory structure

```text
brand/darbot/logo/source/
brand/darbot/logo/svg/
brand/darbot/logo/png/
brand/darbot/logo/app-icons/
brand/darbot/logo/social/
brand/darbot/logo/print/
brand/darbot/logo/motion/
brand/darbot/logo/docs/
```

## Naming convention

```text
darbot-ghost-core-v1--{variant}--{size}.{ext}
```

Examples:

```text
darbot-ghost-core-v1--master--2048.png
darbot-ghost-core-v1--transparent--1024.png
darbot-core-emblem-v1--full-color.svg
darbot-ghost-core-v1--avatar--1080.png
```

## Required master assets

| Asset | Filename | Format | Size | Background | Purpose |
|---|---|---|---:|---|---|
| Canonical raster | `darbot-ghost-core-v1--master--2048.png` | PNG | 2048² | Black | Source-of-truth raster reference |
| Vector master | `darbot-ghost-core-v1--master.svg` | SVG | Scalable | Transparent + optional black layer | Editable primary vector |
| Design source | `darbot-ghost-core-v1--master.fig` / `.ai` | Figma/AI | Scalable | Layered | Brand design source |
| Transparent raster | `darbot-ghost-core-v1--transparent--2048.png` | PNG | 2048² | Transparent | Dark UI placement |
| Flat/no-glow raster | `darbot-ghost-core-v1--flat-no-glow--1024.png` | PNG | 1024² | Transparent | Small UI/performance use |
| Monochrome light | `darbot-ghost-core-v1--mono-light.svg` | SVG | Scalable | Transparent | One-color mark on dark |
| Monochrome dark | `darbot-ghost-core-v1--mono-dark.svg` | SVG | Scalable | Transparent | One-color mark on light |
| Print handoff | `darbot-ghost-core-v1--print-cmyk.pdf` | PDF | Vector | Transparent/black variants | Print vendor package |

## PNG export set

| Filename pattern | Sizes | Background | Notes |
|---|---:|---|---|
| `darbot-ghost-core-v1--black--{size}.png` | 2048, 1024, 512, 256, 128, 64 | Black | Full-color canonical square exports |
| `darbot-ghost-core-v1--transparent--{size}.png` | 2048, 1024, 512, 256, 128 | Transparent | Use only on dark/controlled surfaces |
| `darbot-ghost-core-v1--flat--{size}.png` | 1024, 512, 256, 128, 64, 32 | Transparent | Simplified no-glow variant |
| `darbot-ghost-core-v1--small-simplified--{size}.png` | 128, 64, 48, 32, 16 | Black or transparent | Simplify emblem cuts for tiny sizes |

## SVG export set

| Asset | Filename | Notes |
|---|---|---|
| Full-color SVG | `darbot-ghost-core-v1--full-color.svg` | Use gradients and controlled glow filters |
| Transparent SVG | `darbot-ghost-core-v1--transparent.svg` | No background rectangle |
| Black-tile SVG | `darbot-ghost-core-v1--black-tile.svg` | Includes black background rectangle |
| Flat SVG | `darbot-ghost-core-v1--flat-no-glow.svg` | No blur/filter effects |
| Monochrome SVG | `darbot-ghost-core-v1--mono-light.svg`, `darbot-ghost-core-v1--mono-dark.svg` | For embroidery, etching, single-color print |
| Emblem-only SVG | `darbot-core-emblem-v1--full-color.svg` | Globe/lightning submark |
| Ghost-only SVG | `darbot-ghost-shell-v1--full-color.svg` | Mascot without core emblem |

## App and platform icons

| Platform | Filenames / sizes | Background | Notes |
|---|---|---|---|
| iOS App Store | `darbot-ios-app-icon-1024.png` | Black | No transparency for iOS app icon source |
| iOS runtime icons | 180, 167, 152, 120, 87, 80, 76, 60, 58, 40, 29, 20 px | Black | Generate from master; inspect for emblem legibility |
| Android adaptive | `foreground-432.png`, `background-432.png` | Layered | Keep ghost inside adaptive safe zone |
| Android legacy | 512, 192, 144, 96, 72, 48 px | Black | Include Play Store 512 px |
| PWA manifest | `icon-192.png`, `icon-512.png`, `maskable-icon-512.png` | Black | Maskable icon needs larger safe area |
| Browser favicon | `favicon-16.png`, `favicon-32.png`, `favicon-48.png`, `favicon.ico` | Black or simplified emblem | Prefer simplified emblem at 16 px |
| macOS/Windows/Linux | `.icns`, `.ico`, 512, 256, 128, 64, 32, 16 px | Black | Include platform bundle icons |

## Social and community assets

| Use | Filename | Size | Notes |
|---|---|---:|---|
| Universal avatar | `darbot-ghost-core-v1--avatar--1080.png` | 1080² | High-res social/community profile |
| GitHub org/avatar | `darbot-ghost-core-v1--github--460.png` | 460² | Verify circular crop |
| Discord server/avatar | `darbot-ghost-core-v1--discord--512.png` | 512² | Verify circular crop |
| X/Twitter avatar | `darbot-ghost-core-v1--x-avatar--400.png` | 400² | Verify circular crop |
| LinkedIn company logo | `darbot-ghost-core-v1--linkedin--400.png` | 400² | Ensure black tile remains visible |
| YouTube channel avatar | `darbot-ghost-core-v1--youtube-avatar--800.png` | 800² | Verify circular crop |
| Open Graph image | `darbot-og-image--1200x630.png` | 1200×630 | Use full mark left/center with optional wordmark area |
| X summary card | `darbot-x-card--1200x675.png` | 1200×675 | Dark hero card version |
| GitHub social preview | `darbot-github-preview--1280x640.png` | 1280×640 | Optional wordmark and tagline area |
| LinkedIn cover | `darbot-linkedin-cover--1128x191.png` | 1128×191 | Use emblem/wordmark; full ghost may be too tall |
| YouTube banner | `darbot-youtube-banner--2560x1440.png` | 2560×1440 | Keep important content in center safe area |

## Presentation, docs, and web assets

| Use | Filename | Size / format | Notes |
|---|---|---|---|
| Deck logo transparent | `darbot-ghost-core-v1--deck--1024.png` | 1024² PNG | Transparent, for dark slides |
| Deck logo black tile | `darbot-ghost-core-v1--deck-black--1024.png` | 1024² PNG | For light slides |
| Website header mark | `darbot-ghost-core-v1--web-header.svg` | SVG | Prefer no glow or restrained glow |
| Website hero mark | `darbot-ghost-core-v1--web-hero--2048.png` | 2048² PNG | Full glow version |
| README badge | `darbot-core-emblem-v1--readme-badge.svg` | SVG | Emblem-only small badge |
| Email signature | `darbot-ghost-core-v1--email--256.png` | 256² PNG | Keep file size small |
| Press kit preview | `darbot-logo-preview-sheet.pdf` | PDF | Include full logo, emblem, mono variants |

## Motion assets

| Asset | Filename | Format | Notes |
|---|---|---|---|
| Subtle glow loop | `darbot-ghost-core-v1--glow-loop.lottie` | Lottie JSON | Slow pulse, no rapid flashing |
| Agent active state | `darbot-ghost-core-v1--active.webm` | WebM | Slight visor/emblem glow pulse |
| Loading spinner | `darbot-core-emblem-v1--loader.lottie` | Lottie JSON | Rotate/energize the globe-lightning submark |
| Transparent GIF fallback | `darbot-ghost-core-v1--glow-loop.gif` | GIF | Use only where Lottie/WebM unavailable |

## Print and physical production assets

| Use | Filename / format | Notes |
|---|---|---|
| CMYK vector | `darbot-ghost-core-v1--print-cmyk.pdf` | Neon RGB colors require proofed CMYK approximation |
| Spot color proof | `darbot-ghost-core-v1--spot-color-proof.pdf` | Optional fluorescent/spot-color treatment |
| Embroidery simplification | `darbot-ghost-core-v1--embroidery-mono.svg` | Simplify visor dots and emblem cuts |
| Vinyl/sticker cutline | `darbot-ghost-core-v1--sticker-cutline.svg` | Include bleed and rounded cut contour |
| Laser/etching | `darbot-ghost-core-v1--etch-mono.svg` | Single-color line art, no glow |

## Usage rules

- Prefer black or very dark backgrounds.
- Keep at least 12% canvas-width clearspace around the full mascot whenever possible.
- Do not crop the top arch, side outline, or lower ghost waves.
- Do not distort, skew, stretch, or rotate the logo for normal brand use.
- Do not place the full-color mark directly on white unless it sits inside a black/dark tile.
- Do not remove the updated globe-lightning core emblem from the primary logo.
- Use emblem-only or simplified variants for 16–48 px contexts.
- Keep the three visor status dots red, cyan, and green unless creating an explicitly named system-state variant.
- Use subtle motion only; avoid fast flashing or intense pulse effects.

## QA checklist

- Verify SVG gradients and blur filters render correctly in Chromium, Safari, Firefox, and embedded WebViews.
- Confirm 512, 256, 128, 64, 32, and 16 px exports are manually inspected.
- Confirm circular crops for GitHub, Discord, X, LinkedIn, and YouTube.
- Confirm dark-mode and light-mode placements.
- Confirm transparent exports retain enough contrast on dark surfaces.
- Confirm app-icon safe zones for iOS, Android adaptive, PWA maskable, and desktop bundles.
- Compress PNGs losslessly and keep master assets uncompressed or minimally optimized.
- Store the source raster hash and version in the brand changelog.
