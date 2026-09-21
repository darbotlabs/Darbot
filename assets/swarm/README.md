# Darbot Swarm integration

This is the canonical asset destination for the approved Solid64 v2.0.0 and
Mint/Opal64 v3.0.0 cohorts. The original imported directories remain untouched.

| Directory | Contents |
| --- | --- |
| `canonical` | Five approved source artifacts, including the logo, token master and opal reference |
| `cohort-01-solid64` | Complete extracted Solid64 pack, its original manifest, schemas, exports and checksums |
| `cohort-02-mint-opal64` | Complete extracted Mint/Opal compact pack and its original metadata/checksums |
| `generated` | Deterministic, typed integration registry derived from the two manifests |

`scripts/swarm-assets.ts` adapts both source schemas into one descriptive model.
`shared/swarm-identity.ts` resolves that model for the web and desktop UI.
`shared/swarm-frameworks.ts` binds the 15 existing adapter IDs without changing
their directories, protocols, endpoint configuration or permissions. The other
113 entries remain proposed perspectives, not instantiated agent runtimes.

Run `bun run generate:swarm` after an intentionally approved manifest change.
Run `bun run verify:swarm` to verify all 1,217 packaged checksum entries, the five
canonical source hashes, the alpha master, chest placement, and generated-registry
freshness. Both production builds also perform this validation and emit only the
896 existing PNGs referenced by the effective registry. They do not regenerate,
recolor, resize, flatten, trace or otherwise transform the source artwork.

The compact Mint/Opal source manifest declares full-pack 2048 and SVG paths that
are not shipped. Those declarations are preserved in the source manifest, but
the application registry exposes only the available 1024/512/256 exports.
No approximate substitutes are produced.

Pack text files are byte-locked with `.gitattributes` because their checksums
include line endings. Formatters exclude this directory. Do not format or edit
the imported manifests, source files, artwork, or their checksum lists.

The imported handoff is
`assets/darbot_swarm_v1/PROMPT_GPT_COWORK_DARBOT_SWARM_INTEGRATION.md`.
Its preferred `assets/darbot-swarm` name is superseded by the user's explicit
`assets/swarm` destination. Its advertised ZIP archives are absent from this
checkout; the complete extracted packs were verified directly before staging.
