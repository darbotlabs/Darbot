# Darbot AI Mock

`@darbotlm/aimock` is Darbot's private, zero-runtime-dependency mock implementation
for LLM, MCP, and AG-UI protocol tests.

Run `bun install --frozen-lockfile` and `bun run build:sdk` from `E:\Darbot`.
`LLMock` and `buildAGUITextResponse` are available from `@darbotlm/aimock`;
`AGUIMock` is available from `@darbotlm/aimock/agui`, and `MCPMock` from
`@darbotlm/aimock/mcp`.

The mock servers implement the protocols locally rather than replacing them
with always-successful responses or forwarding requests to an external SDK.
Source revisions and adaptations are recorded in `packages\source-provenance.json`.
The original MIT copyright and license notices are retained in `LICENSE`.
