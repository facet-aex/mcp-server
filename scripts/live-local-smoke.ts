import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadEnvFile } from "node:process";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const facetId = process.env.FACET_DEMO_FACET_ID;
const versionId = process.env.FACET_DEMO_VERSION_ID;
if (!facetId || !versionId)
  throw new Error("FACET_DEMO_FACET_ID and FACET_DEMO_VERSION_ID are required");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/server.js", import.meta.url).pathname],
  env: {
    ...process.env,
    FACET_CONTROL_API_URL:
      process.env.FACET_CONTROL_API_URL ?? "http://127.0.0.1:4000",
    FACET_GATEWAY_URL: process.env.FACET_GATEWAY_URL ?? "http://127.0.0.1:4020",
  },
  stderr: "pipe",
});
const client = new Client({ name: "facet-live-smoke", version: "0.1.0" });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map(({ name }) => name).sort();
  if (tools.join(",") !== "get_facet,invoke_facet,search_facets")
    throw new Error(`Unexpected tools: ${tools}`);
  const search = await client.callTool({
    name: "search_facets",
    arguments: { query: "GitHub public repository" },
  });
  if (!JSON.stringify(search).includes(facetId))
    throw new Error("Published Facet not found by MCP search");
  const detail = await client.callTool({
    name: "get_facet",
    arguments: { facetId },
  });
  if (!JSON.stringify(detail).includes(versionId))
    throw new Error("MCP detail returned wrong version");
  const args = {
    facetVersionId: versionId,
    input: { path: { owner: "octocat", repo: "Hello-World" } },
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
  if (
    !JSON.stringify(first).includes("octocat/Hello-World") ||
    replayBody?.replayed !== true
  ) {
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
    "MCP stdio search, detail, real GitHub invocation and replay passed.\n",
  );
} finally {
  await client.close();
}
