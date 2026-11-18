# `@facet-aex/mcp-server`

Local stdio MCP adapter (`facet-mcp`) for FACET capability discovery (`search_facets`, `get_facet`) and policy-bounded Avalanche Fuji x402 invocation (`invoke_facet`).

## Architecture

- Consumes `@facet-aex/cli` (`WalletStore`, `PolicyStore`, `SpendLedger`, `readFujiWalletStatus`) directly — no `FACET_DEMO_PAYER_PRIVATE_KEY` environment variable or plaintext key in client MCP configuration.
- Uses `https://facet.briandev.space` as the single public catalog and gateway origin.
- Default-deny spending enforcement: checks granted exact version, Fuji `43113`, `fUSD` (`0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f`), pinned `FacetFeeSplitAndEscrow` settlement recipient, pinned creator `payTo`, live fUSD balance, and process-locked daily caps before signing.

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
