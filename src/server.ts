#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_FACET_ORIGIN,
  FacetClient,
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
        "FACET is a multi-modal capability marketplace on Avalanche unifying HOSTED_ACTOR (Docker Actors returning structured Datasets), AUTONOMOUS_AGENT (ERC-8004 bound A2A Agents), and EXTERNAL_HTTP_API services. First call search_facets with a short intent phrase (optionally filtering by type or category), then call get_facet (by <username>/<facet-name> or facetId) to inspect its inputSchema, pricing, actorMeta.imageDigest or agentMeta.erc8004TokenId. Construct input matching inputSchema and call invoke_facet, which enforces local operator spending policies and Fuji testnet fUSD x402 payment before returning result, dataset, usage, payment, and on-chain receipt.",
    },
  );

  server.registerTool(
    "search_facets",
    {
      description:
        "Search the FACET marketplace for Hosted Actors, ERC-8004 A2A Agents, or External APIs by intent, optional facetType, and optional category.",
      inputSchema: {
        query: z.string().max(120).default(""),
        type: z
          .enum(["EXTERNAL_HTTP_API", "HOSTED_ACTOR", "AUTONOMOUS_AGENT"])
          .optional(),
        category: z.string().max(80).optional(),
      },
    },
    async ({ query, type, category }) => {
      const params = new URLSearchParams();
      params.set("q", query);
      if (type) params.set("type", type);
      if (category) params.set("category", category);
      const path = `/v1/catalog/facets?${params.toString()}`;
      return toolResult(await requestCatalog(controlUrl, path));
    },
  );

  server.registerTool(
    "get_facet",
    {
      description:
        "Read a published Facet's inputSchema, outputSchema, pricing, actorMeta (imageDigest), and agentMeta (ERC-8004 Token ID) by <username>/<facet-name> or facetId before invoking it.",
      inputSchema: { facetId: z.string().min(1).max(160) },
    },
    async ({ facetId }) => {
      const facet = await catalogClient.resolveFacet(facetId);
      if (!facet) {
        throw new Error(`FACET not found: ${facetId}`);
      }
      return toolResult({ facet });
    },
  );

  server.registerTool(
    "invoke_facet",
    {
      description:
        "Execute a Hosted Actor, ERC-8004 A2A Agent, or External API with input matching get_facet's schema. Validates local operator policy, signs Fuji testnet fUSD x402 payment locally without exposing keys, and returns result, dataset, usage, payment, and Snowtrace receipt links.",
      inputSchema: {
        facetVersionId: z.string().uuid(),
        input: z.record(z.string(), z.unknown()),
        idempotencyKey: z.string().min(1).max(128).optional(),
      },
    },
    async ({ facetVersionId, input, idempotencyKey }) => {
      const res = await invokeWithPayment({
        controlUrl,
        gatewayUrl,
        facetVersionId,
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
