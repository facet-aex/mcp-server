import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { invokeWithPayment } from "./payment.js";

const controlUrl = process.env.FACET_CONTROL_API_URL;
const gatewayUrl = process.env.FACET_GATEWAY_URL;
if (!controlUrl) throw new Error("FACET_CONTROL_API_URL is required");

async function request(
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
  if (!response.ok)
    throw new Error(
      `FACET service returned ${response.status}: ${JSON.stringify(body)}`,
    );
  return body;
}

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}

const server = new McpServer(
  { name: "facet", version: "0.2.0" },
  {
    instructions:
      "FACET is a multi-modal capability marketplace on Avalanche unifying HOSTED_ACTOR (Docker Actors returning structured Datasets), AUTONOMOUS_AGENT (ERC-8004 bound A2A Agents), and EXTERNAL_HTTP_API services. First call search_facets with a short intent phrase (optionally filtering by type or category), then call get_facet to inspect its inputSchema, pricing, actorMeta.imageDigest or agentMeta.erc8004TokenId. Construct input matching inputSchema and call invoke_facet, which handles capped Fuji testnet fUSD x402 payment and returns result, dataset, usage, payment, and on-chain receipt.",
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
    return result(await request(controlUrl, path));
  },
);

server.registerTool(
  "get_facet",
  {
    description:
      "Read a published Facet's inputSchema, outputSchema, pricing, actorMeta (imageDigest), and agentMeta (ERC-8004 Token ID) before invoking it.",
    inputSchema: { facetId: z.string().uuid() },
  },
  async ({ facetId }) =>
    result(await request(controlUrl, `/v1/catalog/facets/${facetId}`)),
);

server.registerTool(
  "invoke_facet",
  {
    description:
      "Execute a Hosted Actor, ERC-8004 A2A Agent, or External API with input matching get_facet's schema. Automatically handles capped Fuji testnet fUSD x402 payment and returns result, dataset, usage, payment, and on-chain receipt.",
    inputSchema: {
      facetVersionId: z.string().uuid(),
      input: z.record(z.string(), z.unknown()),
      idempotencyKey: z.string().min(1).max(128).optional(),
    },
  },
  async ({ facetVersionId, input, idempotencyKey }) => {
    if (!gatewayUrl)
      throw new Error("FACET_GATEWAY_URL is required to invoke Facets");
    return result(
      await invokeWithPayment(
        gatewayUrl,
        facetVersionId,
        input,
        idempotencyKey ?? randomUUID(),
      ),
    );
  },
);

await server.connect(new StdioServerTransport());
