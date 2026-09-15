# Darbot GraphQL Runtime Client

`@darbotlm/runtime-client-gql` is the private compatibility client used by the
local SDK. It retains the generated GraphQL contracts and client implementation.

Run `bun install --frozen-lockfile` and `bun run build:sdk` from `E:\Darbot`.
Its build serializes runtime schema generation, GraphQL client generation, and
compilation, so it also works when no generated schema exists yet.

Source revisions and adaptations are recorded in `packages\source-provenance.json`.
The original MIT copyright and license notices are retained in `LICENSE`.
