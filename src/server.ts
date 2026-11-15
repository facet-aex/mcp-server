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
  { name: "facet", version: "0.1.0" },
  {
    instructions:
      "FACET is a marketplace of live API capabilities. When a user asks for current external data or an analysis requiring external data, search_facets using a short capability phrase (for example, 'bitcoin price history'), then get_facet for the best match to read its input schema. Infer input from the user's request, invoke_facet, and analyze the returned data. If search has no results, try a shorter English synonym. Never invent a Facet or an API result. Invocations may spend capped Fuji testnet fUSD.",
  },
);
server.registerTool(
  "search_facets",
  {
    description:
      "Search the FACET marketplace for live API capabilities by natural language intent. Use this first when a task needs external data; try short phrases such as 'Bitcoin historical price chart'.",
    inputSchema: { query: z.string().max(120).default("") },
  },
  async ({ query }) => {
    const path = `/v1/catalog/facets?q=${encodeURIComponent(query)}`;
    return result(await request(controlUrl, path));
  },
);
server.registerTool(
  "get_facet",
  {
    description:
      "Read a published Facet's input and output schema before invoking it. Use the returned versionId and construct input from the user's intent.",
    inputSchema: { facetId: z.string().uuid() },
  },
  async ({ facetId }) =>
    result(await request(controlUrl, `/v1/catalog/facets/${facetId}`)),
);
server.registerTool(
  "invoke_facet",
  {
    description:
      "Call the selected FACET API capability with input matching get_facet's schema. The local payer handles a capped Fuji testnet x402 payment automatically when configured.",
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
