# Darbot Runtime

`@darbotlm/runtime` is the private server SDK workspace for Darbot. It contains
the runtime, built-in agents, Intelligence integration, framework adapters, and
legacy GraphQL compatibility implementation.

Run `bun install --frozen-lockfile` and `bun run build:sdk` from `E:\Darbot`.
Server imports use `@darbotlm/runtime/v2` and `@darbotlm/runtime/v2/hono`.
Existing public identifiers and protocol contracts are preserved.

The GraphQL client workspace invokes this package's schema generator before its
own code generation. A clean build does not require a previously generated schema.

This package is implemented here, not installed through a registry alias.
Source revisions and adaptations are recorded in `packages\source-provenance.json`.
The original MIT copyright and license notices are retained in `LICENSE`.
