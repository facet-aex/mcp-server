# FACET MCP Server (`@facet-aex/mcp-server`)

[![FACET](https://img.shields.io/badge/FACET-facet.briandev.space-050505?style=flat-square&labelColor=DFFF4F)](https://facet.briandev.space)
[![Layer](https://img.shields.io/badge/MCP-STDIO%20SERVER-0D0D0D?style=flat-square&labelColor=343434)](https://github.com/facet-aex)

> Public local stdio Model Context Protocol (MCP) server (`facet-mcp`) enabling AI agents to discover, pay for, and invoke FACET capabilities.

## Overview

`mcp-server` (published to npm as `@facet-aex/mcp-server`) bridges AI assistants and autonomous agents with the **FACET** marketplace. Running locally over stdio, it discovers published capabilities, enforces local buyer policies, signs x402 `fUSD` authorizations, and returns execution outputs with verifiable on-chain proof.

## Role in FACET

- **Canonical MCP Tools:** Exposes `search_facets`, `get_facet`, and `invoke_facet` using natural-key identifiers (`provider`, `facetName`, SemVer `version`) across `API`, `ACTOR`, and `AGENT` modalities.
- **Policy-Bounded Signing:** Delegates wallet custody, default-deny spend checks, and local ledger accounting to `@facet-aex/cli` so private keys never enter LLM context or MCP config files.
- **Reliable x402 Execution:** Signs EIP-3009 authorizations for `PAY_PER_RUN` and `PAY_PER_RESULT` challenges, retains `PAYMENT-SIGNATURE` across `202` pending retries without double-paying, and surfaces settled amounts and transaction links.

## Tech Stack

| Layer | Technology |
|---|---|
| Language & Runtime | TypeScript, Node.js (`>=22.0.0`, ESM) |
| Protocol & SDK | `@modelcontextprotocol/sdk`, Zod, `@facet-aex/cli` |
| x402 & Web3 | `@x402/core`, `@x402/evm`, `viem` |
| Distribution | Public npm (`@facet-aex/mcp-server`, OIDC Trusted Publishing) |
| Testing | Vitest, Prettier |

---

Part of **[FACET](https://facet.briandev.space)** (`facet-aex`) — Federated Agent Capability Exchange & Trust on Avalanche · [Documentation](https://facet.briandev.space/docs)
