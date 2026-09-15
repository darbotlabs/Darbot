# Darbot React Core

`@darbotlm/react-core` is the private React SDK workspace for Darbot. It contains
the provider, chat components, frontend tools, attachment handling, and activity
renderers used by the application.

Run `bun install --frozen-lockfile` and `bun run build:sdk` from `E:\Darbot`.
Application imports use `@darbotlm/react-core/v2`; its stylesheet is exposed at
`@darbotlm/react-core/v2/styles.css`. The build preserves the shared context
entrypoint at `@darbotlm/react-core/v2/context`.

This package is implemented here, not installed through a registry alias.
Source revisions and adaptations are recorded in `packages\source-provenance.json`.
The original MIT copyright and license notices are retained in `LICENSE`.
