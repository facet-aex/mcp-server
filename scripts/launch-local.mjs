import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
for (const name of [
  "FACET_CONTROL_API_URL",
  "FACET_GATEWAY_URL",
  "FACET_DEMO_PAYER_PRIVATE_KEY",
  "FACET_DEMO_PAY_TO",
  "FACET_DEMO_MAX_PAYMENT_ATOMIC",
]) {
  if (!process.env[name]) throw new Error(`Missing ${name} in mcp-server/.env`);
}
await import("../dist/server.js");
