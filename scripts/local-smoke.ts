import { createServer } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  encodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
} from "@x402/core/http";
import { generatePrivateKey } from "viem/accounts";

const facetId = "00000000-0000-4000-8000-000000000001";
const versionId = "00000000-0000-4000-8000-000000000002";
const recipient = "0x0000000000000000000000000000000000000001";
const asset = "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f";
let signedCalls = 0;
const httpServer = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url?.startsWith("/v1/catalog/facets?")) {
    response.end(
      JSON.stringify({
        facets: [{ id: facetId, versionId, name: "GitHub repository" }],
      }),
    );
    return;
  }
  if (request.url === `/v1/catalog/facets/${facetId}`) {
    response.end(
      JSON.stringify({
        facet: { id: facetId, versionId, name: "GitHub repository" },
      }),
    );
    return;
  }
  if (request.url === `/v1/facet-versions/${versionId}/invoke`) {
    const signature = request.headers["payment-signature"];
    if (typeof signature !== "string") {
      const required = {
        x402Version: 2,
        resource: {
          url: `http://127.0.0.1:4033/v1/facet-versions/${versionId}/invoke?fingerprint=smoke`,
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:43113",
            asset,
            amount: "1000",
            payTo: recipient,
            maxTimeoutSeconds: 60,
            extra: { name: "FACET USD", version: "2" },
          },
        ],
      };
      response.setHeader(
        "PAYMENT-REQUIRED",
        encodePaymentRequiredHeader(required),
      );
      response.writeHead(402).end(JSON.stringify(required));
      return;
    }
    const payload = decodePaymentSignatureHeader(signature);
    if (payload.accepted.amount !== "1000") {
      response.writeHead(400).end();
      return;
    }
    signedCalls++;
    response.end(
      JSON.stringify({
        runId: facetId,
        facetVersionId: versionId,
        result: { full_name: "octocat/Hello-World" },
        replayed: false,
        payment: {
          transaction: `0x${"1".repeat(64)}`,
          network: "eip155:43113",
        },
      }),
    );
    return;
  }
  response.writeHead(404).end(JSON.stringify({ error: "NOT_FOUND" }));
});
await new Promise<void>((resolve) =>
  httpServer.listen(4033, "127.0.0.1", resolve),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/server.js", import.meta.url).pathname],
  env: {
    ...process.env,
    FACET_CONTROL_API_URL: "http://127.0.0.1:4033",
    FACET_GATEWAY_URL: "http://127.0.0.1:4033",
    FACET_DEMO_PAYER_PRIVATE_KEY: generatePrivateKey(),
    FACET_DEMO_PAY_TO: recipient,
    FACET_DEMO_MAX_PAYMENT_ATOMIC: "1000",
  },
  stderr: "pipe",
});
const client = new Client({ name: "facet-smoke-client", version: "0.1.0" });
try {
  await client.connect(transport);
  if (!client.getInstructions()?.includes("search_facets"))
    throw new Error("MCP server did not advertise the discovery workflow");
  const names = (await client.listTools()).tools
    .map((tool) => tool.name)
    .sort();
  if (names.join(",") !== "get_facet,invoke_facet,search_facets")
    throw new Error(`Unexpected MCP tools: ${names.join(",")}`);
  const searched = await client.callTool({
    name: "search_facets",
    arguments: { query: "GitHub" },
  });
  if (!JSON.stringify(searched).includes("GitHub repository"))
    throw new Error("MCP search did not return the catalog item");
  const detail = await client.callTool({
    name: "get_facet",
    arguments: { facetId },
  });
  if (!JSON.stringify(detail).includes(versionId))
    throw new Error("MCP detail did not return version");
  const invoked = await client.callTool({
    name: "invoke_facet",
    arguments: {
      facetVersionId: versionId,
      input: { path: { owner: "octocat", repo: "Hello-World" } },
    },
  });
  if (
    !JSON.stringify(invoked).includes("octocat/Hello-World") ||
    signedCalls !== 1
  )
    throw new Error(`MCP paid retry failed: ${JSON.stringify(invoked)}`);
  process.stdout.write(
    "MCP stdio search, detail and mocked x402 sign/retry passed.\n",
  );
} finally {
  await client.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
