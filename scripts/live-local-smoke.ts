import { DEFAULT_FACET_ORIGIN } from "@facet-aex/cli";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const provider = process.env.FACET_DEMO_PROVIDER;
const facetName = process.env.FACET_DEMO_FACET_NAME;
const version = process.env.FACET_DEMO_VERSION;
if (!provider || !facetName || !version) {
  throw new Error(
    "FACET_DEMO_PROVIDER, FACET_DEMO_FACET_NAME, and FACET_DEMO_VERSION are required",
  );
}

const input = process.env.FACET_DEMO_INPUT_JSON
  ? (JSON.parse(process.env.FACET_DEMO_INPUT_JSON) as Record<string, unknown>)
  : { path: { owner: "octocat", repo: "Hello-World" } };

const origin = process.env.FACET_ORIGIN ?? DEFAULT_FACET_ORIGIN;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/server.js", import.meta.url).pathname],
  env: {
    ...process.env,
    FACET_CONTROL_API_URL: process.env.FACET_CONTROL_API_URL ?? origin,
    FACET_GATEWAY_URL: process.env.FACET_GATEWAY_URL ?? origin,
  },
  stderr: "pipe",
});

const client = new Client({ name: "facet-live-smoke", version: "0.2.0" });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(({ name }) => name).sort();
  if (tools.join(",") !== "get_facet,invoke_facet,search_facets")
    throw new Error(`Unexpected tools: ${tools}`);
  const search = await client.callTool({
    name: "search_facets",
    arguments: { query: facetName },
  });
  if (!JSON.stringify(search).includes(facetName))
    throw new Error("Published Facet not found by MCP search");
  const detail = await client.callTool({
    name: "get_facet",
    arguments: { provider, facetName, version },
  });
  if (!JSON.stringify(detail).includes(version))
    throw new Error("MCP detail returned wrong version");
  const args = {
    provider,
    facetName,
    version,
    input,
    idempotencyKey:
      process.env.FACET_DEMO_IDEMPOTENCY_KEY ?? `mcp-live-${Date.now()}`,
  };
  const first = await client.callTool({
    name: "invoke_facet",
    arguments: args,
  });
  const replay = await client.callTool({
    name: "invoke_facet",
    arguments: args,
  });
  const replayContent = replay.content[0];
  const replayBody =
    replayContent?.type === "text"
      ? (JSON.parse(replayContent.text) as {
          replayed?: boolean;
          payment?: { transaction?: string; network?: string };
        })
      : undefined;
  if (first.isError || replay.isError || replayBody?.replayed !== true) {
    throw new Error(
      `MCP invocation/replay failed: ${JSON.stringify({ first, replay })}`,
    );
  }
  if (
    process.env.FACET_DEMO_EXPECT_PAYMENT === "1" &&
    (!/^0x[a-f0-9]{64}$/iu.test(replayBody?.payment?.transaction ?? "") ||
      replayBody?.payment?.network !== "eip155:43113")
  ) {
    throw new Error("MCP paid result missing Fuji transaction reference");
  }
  process.stdout.write(
    "MCP stdio search, detail, live invocation and replay passed.\n",
  );
} finally {
  await client.close();
}
