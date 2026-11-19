#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FACET_ORIGIN,
  FACET_NAME_REGEX,
  FACET_TYPES,
  FacetClient,
  SEMVER_REGEX,
  USERNAME_REGEX,
  redactSecrets,
} from "@facet-aex/cli";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createLocalBuyerRuntime,
  type LocalBuyerRuntime,
} from "./local-wallet.js";
import { invokeWithPayment } from "./payment.js";

export interface FacetMcpServerConfig {
  controlUrl?: string;
  gatewayUrl?: string;
  runtime?: LocalBuyerRuntime;
}

async function requestCatalog(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await fetch(new URL(path, base), {
    ...init,
    signal: AbortSignal.timeout(15_000),
    headers: { accept: "application/json", ...init?.headers },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(
      redactSecrets(
        `FACET service returned ${response.status}: ${JSON.stringify(body)}`,
      ),
    );
  }
  return body;
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

export function createFacetMcpServer(config: FacetMcpServerConfig = {}) {
  const origin =
    config.controlUrl ??
    process.env.FACET_CONTROL_API_URL ??
    process.env.FACET_ORIGIN ??
    DEFAULT_FACET_ORIGIN;
  const controlUrl = origin;
  const gatewayUrl =
    config.gatewayUrl ?? process.env.FACET_GATEWAY_URL ?? origin;
  const runtime = config.runtime ?? createLocalBuyerRuntime();
  const catalogClient = new FacetClient({ controlApiUrl: controlUrl });

  const server = new McpServer(
    { name: "facet", version: "0.2.0" },
    {
      instructions:
        "FACET is a multi-modal capability marketplace on Avalanche unifying ACTOR (Docker Actors returning structured Datasets), AGENT (ERC-8004 bound A2A Agents), and API services. First call search_facets with a short intent phrase (optionally filtering by type API|ACTOR|AGENT or category), then call get_facet with { provider, facetName, version? } to inspect its inputSchema, outputSchema, pricing, actorMeta.imageDigest or agentMeta.erc8004TokenId. Construct input matching inputSchema and call invoke_facet with { provider, facetName, version, input, idempotencyKey? }, which enforces local operator spending policies and Fuji testnet fUSD x402 payment before returning result, dataset, usage, payment, and on-chain receipt.",
    },
  );

  server.registerTool(
    "search_facets",
    {
      description:
        "Search the FACET marketplace for Actors, ERC-8004 A2A Agents, or APIs by intent, optional facetType (API|ACTOR|AGENT), category, and limit.",
      inputSchema: {
        query: z.string().max(120).default(""),
        type: z.enum(FACET_TYPES).optional(),
        category: z.string().max(80).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async ({ query, type, category, limit }) => {
      const params = new URLSearchParams();
      params.set("q", query);
      if (type) params.set("type", type);
      if (category) params.set("category", category);
      if (limit !== undefined) params.set("limit", String(limit));
      const path = `/v1/catalog/facets?${params.toString()}`;
      return toolResult(await requestCatalog(controlUrl, path));
    },
  );

  server.registerTool(
    "get_facet",
    {
      description:
        "Read a published Facet's inputSchema, outputSchema, pricing, actorMeta (imageDigest), and agentMeta (ERC-8004 Token ID) by separated provider, facetName, and optional SemVer version before invoking it.",
      inputSchema: {
        provider: z.string().regex(USERNAME_REGEX),
        facetName: z.string().regex(FACET_NAME_REGEX),
        version: z.string().regex(SEMVER_REGEX).optional(),
      },
    },
    async ({ provider, facetName, version }) => {
      const facet = await catalogClient.getFacet(provider, facetName, version);
      if (!facet) {
        throw new Error(
          `FACET not found: ${provider}/${facetName}${version ? `@${version}` : ""}`,
        );
      }
      return toolResult({ facet });
    },
  );

  server.registerTool(
    "invoke_facet",
    {
      description:
        "Execute a published Actor, ERC-8004 A2A Agent, or API with { provider, facetName, version, input }. Validates local operator policy, signs Fuji testnet fUSD x402 payment locally without exposing keys, and returns result, dataset, usage, payment, and Snowtrace receipt links.",
      inputSchema: {
        provider: z.string().regex(USERNAME_REGEX),
        facetName: z.string().regex(FACET_NAME_REGEX),
        version: z.string().regex(SEMVER_REGEX),
        input: z.record(z.string(), z.unknown()),
        idempotencyKey: z.string().min(1).max(128).optional(),
      },
    },
    async ({ provider, facetName, version, input, idempotencyKey }) => {
      const res = await invokeWithPayment({
        controlUrl,
        gatewayUrl,
        provider,
        facetName,
        version,
        input,
        idempotencyKey: idempotencyKey ?? randomUUID(),
        runtime,
      });
      return toolResult(res);
    },
  );

  return server;
}

export async function startFacetMcpStdioServer(
  config: FacetMcpServerConfig = {},
) {
  const server = createFacetMcpServer(config);
  await server.connect(new StdioServerTransport());
  return server;
}

function isDirectEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntry()) {
  await startFacetMcpStdioServer();
}
