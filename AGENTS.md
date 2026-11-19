# `mcp-server` instructions

**Active architectural authority:** `../docs/architecture/decisions/ADR-0018-canonical-identities-semver-and-clerk-webhooks.md`

## Role

MCP server (`@facet-aex/mcp-server`) allowing autonomous AI clients (Codex, Claude Code, Antigravity) to discover, inspect, pay for (`x402` EIP-3009 `fUSD` on Avalanche Fuji `43113`), and invoke all three canonical Facet types (`API`, `ACTOR`, `AGENT`) using policy-bounded local wallets from `@facet-aex/cli`.

## Exposed Meta-Tools (Option B Natural Keys + SemVer)

1. **`search_facets`:**
   - Queries `GET /v1/catalog/facets` with optional `query`, `type` (`API` | `ACTOR` | `AGENT`), `category`, and `limit`.
   - Returns each Facet's `provider` (`users.username`), `facetName`, `facetDisplayName`, SemVer `version`, `facetType`, `pricing`, `actorMeta` (`imageDigest`), and `agentMeta` (`erc8004TokenId`, `erc8004Registry`).
2. **`get_facet`:**
   - Accepts `{ provider, facetName, version? }` and calls `GET /v1/catalog/facets/:provider/:facetName` or `.../versions/:version`.
   - Retrieves full `PublicFacet` details including `inputSchema`, `outputSchema`, `pricing`, `actorMeta`, and `agentMeta`.
3. **`invoke_facet`:**
   - Accepts `{ provider, facetName, version, input, idempotencyKey? }` and invokes `POST /v1/facets/:provider/:facetName/versions/:version/invoke` on `gateway`.
   - Enforces default-deny `PolicyStore` grants, pins `providerPayTo` and `FacetFeeSplitAndEscrow`, locks UTC daily spend caps in `SpendLedger`, signs EIP-3009 `fUSD` without exposing private keys, retains `PAYMENT-SIGNATURE` across `202` pending/timeout retries, and returns settled/pending status with Snowtrace links (`provider`, `facetName`, `facetDisplayName`, `version`, `facetType`, `result`, `dataset`, `usage`, `payment`, `receipt`, `replayed`).
