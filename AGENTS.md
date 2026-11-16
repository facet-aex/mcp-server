# `mcp-server` instructions

**Owner in Wave 1:** Antigravity  
**Active architectural authority:** `../docs/architecture/decisions/ADR-0015-actorbazaar-docker-and-a2a-mvp.md`

## Role

MCP server (`@facet/mcp-server`) allowing existing autonomous AI agents (Claude, Cursor, Antigravity, OpenClaw) to discover, inspect, pay for (`x402` on Avalanche Fuji), and invoke all three Facet types (`HOSTED_ACTOR`, `AUTONOMOUS_AGENT`, `EXTERNAL_HTTP_API`).

## Exposed Meta-Tools

1. **`search_facets`:**
   - Queries `GET /v1/catalog/facets` with optional `query`, `type` (`HOSTED_ACTOR` | `AUTONOMOUS_AGENT` | `EXTERNAL_HTTP_API`), `category`, and `limit`.
   - Returns each Facet's `id`, `versionId`, `name`, `facetType`, `pricing`, `actorMeta` (`imageDigest`), and `agentMeta` (`erc8004TokenId`, `erc8004Registry`).
2. **`get_facet`:**
   - Retrieves full `PublicFacet` details including `inputSchema`, `outputSchema`, `pricing`, `actorMeta`, and `agentMeta`.
3. **`invoke_facet`:**
   - Invokes `POST /v1/facet-versions/:versionId/invoke` on `gateway`, automatically handling the HTTP `402 Payment Required` EIP-3009 `fUSD` signature handshake, and returns `{ runId, facetVersionId, facetType, result, dataset, usage, payment, receipt, replayed }`.
