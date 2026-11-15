import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("./launch-local.mjs", import.meta.url).pathname],
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
  },
  stderr: "pipe",
});
const client = new Client({ name: "facet-launcher-smoke", version: "0.1.0" });
try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(({ name }) => name).sort();
  if (names.join(",") !== "get_facet,invoke_facet,search_facets")
    throw new Error(`Unexpected tools: ${names}`);
  process.stdout.write(
    "FACET local MCP launcher connected and exposed all three tools.\n",
  );
} finally {
  await client.close();
}
