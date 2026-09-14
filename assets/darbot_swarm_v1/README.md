# Darbot Swarm Asset + Agent Perspective Handoff

This archive is a self-contained context bundle for handing the approved Darbot Swarm assets to GPT Cowork (or another coding agent) for integration into the user's local `github.com/darbotlabs/darbot` build.

## Use

1. Extract this handoff bundle somewhere accessible to the local coding agent.
2. Open `PROMPT_GPT_COWORK_DARBOT_SWARM_INTEGRATION.md`.
3. Give that prompt **and the extracted bundle directory** to GPT Cowork.
4. Let Cowork inspect `E:\Darbot` before it copies or modifies anything.

## Included cohorts

### Cohort 01: Solid64 v2

`cohorts/darbot_swarm_solid64_v2_full.zip`

- 64 source-locked Darbot identities.
- Full-resolution production pack.
- Stable semantic agent IDs and separate visual color-token IDs.
- Canonical token alpha has zero geometry drift in the packaged QA.

### Cohort 02: Mint / Opal64 v3

`cohorts/darbot_swarm_mint_opal64_v3_compact.zip`

- 64 additional identities, proposed swarm slots 65–128.
- Includes the 15 requested framework IDs verbatim.
- 47 solid finishes + 17 Opal Lightning material finishes.
- Mint Green is `#50E6C2`.
- Opal Lightning material fallback is `#69CFC2` where scalar color is unavoidable.
- Compact pack contains 1024/512/256 production assets plus deterministic rebuild tooling for omitted 2048/SVG exports.

## Canonical source files

`canonical/` contains the approved logo/token sources needed to compare future transformations against source geometry.

## Important

The older `darbot_swarm_color_variations_v1` pack is intentionally excluded. It was superseded because its visual/token precision did not meet the later source-lock contract.

These packs define **identity assets and perspective metadata**. They do not imply that every perspective is already a running agent implementation.
