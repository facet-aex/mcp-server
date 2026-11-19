# `@facet-aex/mcp-server`

Local stdio MCP adapter (`facet-mcp`) for FACET capability discovery (`search_facets`, `get_facet`) and policy-bounded Avalanche Fuji x402 invocation (`invoke_facet`).

## Architecture

- Consumes `@facet-aex/cli` (`WalletStore`, `PolicyStore`, `SpendLedger`, `readFujiWalletStatus`, canonical Option B identifiers) directly — no `FACET_DEMO_PAYER_PRIVATE_KEY` environment variable or plaintext key in client MCP configuration.
- Uses `https://facet.briandev.space` as the single public catalog and gateway origin.
- Canonical Option B tool contracts (zero UUID identifiers in MCP inputs):
  - `search_facets({ query?, type?: "API" | "ACTOR" | "AGENT", category?, limit? })`
  - `get_facet({ provider, facetName, version? })`
  - `invoke_facet({ provider, facetName, version, input, idempotencyKey? })` -> `POST /v1/facets/:provider/:facetName/versions/:version/invoke`
- Default-deny spending enforcement: verifies strict SemVer `version`, Fuji `43113`, `fUSD` (`0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f`), pinned `FacetFeeSplitAndEscrow` settlement recipient, pinned `providerPayTo`, live fUSD balance, process-locked daily caps before signing, and retains `PAYMENT-SIGNATURE` per idempotent run key across `202` pending/timeout retries without re-signing.

## Supported Runtime & Installation

- **Node.js:** `>=22.0.0`
- Install via `@facet-aex/cli`:
  ```bash
  facet mcp install codex|claude|antigravity [--profile <name>]
  ```

## Verification

```bash
npm ci
npm run verify
npm run smoke:local
```
