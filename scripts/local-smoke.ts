import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FACET_FEE_SPLIT_ADDRESS,
  FUJI_CHAIN_ID,
  FUSD_ASSET_ADDRESS,
  PolicyStore,
  SpendLedger,
  WalletStore,
  type CredentialBackend,
  type FujiRpcClient,
  type PublicFacetRecord,
} from "@facet-aex/cli";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createLocalBuyerRuntime } from "../src/local-wallet.js";
import { invokeWithPayment } from "../src/payment.js";

const facetId = "00000000-0000-4000-8000-000000000001";
const versionId = "00000000-0000-4000-8000-000000000002";
const creatorPayTo = "0x0000000000000000000000000000000000000001";
const paymentTx = `0x${"1".repeat(64)}`;
const receiptTx = `0x${"2".repeat(64)}`;
const payerKey = generatePrivateKey();
const payerAddress = privateKeyToAccount(payerKey).address;

const facet: PublicFacetRecord = {
  id: facetId,
  versionId,
  slug: "github-repository",
  fullName: "octocat/github-repository",
  name: "GitHub repository",
  displayVersion: "v1",
  facetType: "HOSTED_ACTOR",
  pricing: {
    model: "PAY_PER_RUN",
    priceAtomic: "1000",
    assetAddress: FUSD_ASSET_ADDRESS,
    chainId: FUJI_CHAIN_ID,
    payTo: creatorPayTo,
  },
  actorMeta: {
    runtime: "nodejs22-alpine-v1",
    imageDigest: `sha256:${"a".repeat(64)}`,
    registryTxHash: `0x${"9".repeat(64)}`,
    registryVerified: true,
  },
};

let signedCalls = 0;
let mockOrigin = "http://127.0.0.1:4033";
const httpServer = createServer(async (request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url?.startsWith("/v1/catalog/facets?")) {
    response.end(JSON.stringify({ facets: [facet] }));
    return;
  }
  if (
    request.url === `/v1/catalog/facets/${facetId}` ||
    request.url === "/v1/catalog/facets/octocat/github-repository"
  ) {
    response.end(JSON.stringify({ facet }));
    return;
  }
  if (request.url === `/v1/facet-versions/${versionId}/invoke`) {
    const signature = request.headers["payment-signature"];
    if (typeof signature !== "string") {
      const required = {
        x402Version: 2,
        resource: {
          url: `${mockOrigin}/v1/facet-versions/${versionId}/invoke?fingerprint=smoke`,
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:43113",
            asset: FUSD_ASSET_ADDRESS,
            amount: "1000",
            payTo: FACET_FEE_SPLIT_ADDRESS,
            maxTimeoutSeconds: 60,
            extra: {
              name: "FACET USD",
              version: "2",
              creatorPayTo,
            },
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
          transaction: paymentTx,
          network: "eip155:43113",
          amountAtomic: "1000",
          payer: payerAddress,
          creatorPayTo,
        },
        receipt: {
          inputHash: `sha256:${"c".repeat(64)}`,
          outputHash: `sha256:${"d".repeat(64)}`,
          itemCount: 1,
          paymentTxHash: paymentTx,
          receiptTxHash: receiptTx,
          runnerSignature: `0x${"e".repeat(130)}`,
        },
      }),
    );
    return;
  }
  response.writeHead(404).end(JSON.stringify({ error: "NOT_FOUND" }));
});

const tempDir = await mkdtemp(join(tmpdir(), "facet-mcp-smoke-"));
const policyPath = join(tempDir, "policies.json");
const ledgerPath = join(tempDir, "spend-ledger.json");
const policyStore = new PolicyStore({ filePath: policyPath });
await policyStore.grant({
  facet,
  facetId,
  versionId,
  maxPerRunAtomic: "1000",
  dailyCapAtomic: "10000",
  expiresAt: "2030-01-01T00:00:00Z",
});

// Verify local wallet/policy/ledger bundle works over direct HTTP x402 call, plus stdio server protocol smoke.
const memBackend: CredentialBackend = {
  async hasSecret() {
    return true;
  },
  async getSecret() {
    return payerKey;
  },
  async setSecret() {},
};
const walletStore = new WalletStore({ backend: memBackend });
const spendLedger = new SpendLedger({ filePath: ledgerPath });
const fujiClient: FujiRpcClient = {
  async getChainId() {
    return FUJI_CHAIN_ID;
  },
  async readFusdBalance() {
    return 50_000n;
  },
};
const runtime = createLocalBuyerRuntime({
  walletStore,
  policyStore,
  spendLedger,
  fujiClient,
});

await new Promise<void>((resolve) =>
  httpServer.listen(0, "127.0.0.1", resolve),
);
const addr = httpServer.address();
if (!addr || typeof addr === "string") {
  throw new Error("Failed to resolve local smoke server port");
}
mockOrigin = `http://127.0.0.1:${addr.port}`;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("../dist/server.js", import.meta.url).pathname],
  env: {
    ...process.env,
    FACET_CONTROL_API_URL: mockOrigin,
    FACET_GATEWAY_URL: mockOrigin,
    FACET_POLICY_PATH: policyPath,
    FACET_SPEND_LEDGER_PATH: ledgerPath,
  },
  stderr: "pipe",
});

const client = new Client({ name: "facet-smoke-client", version: "0.2.0" });
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
    throw new Error(
      `MCP search did not return the catalog item: ${JSON.stringify(searched)}`,
    );
  const detail = await client.callTool({
    name: "get_facet",
    arguments: { facetId: "octocat/github-repository" },
  });
  if (!JSON.stringify(detail).includes(versionId))
    throw new Error(
      `MCP detail did not resolve username/facet-name: ${JSON.stringify(detail)}`,
    );
  const denied = await client.callTool({
    name: "invoke_facet",
    arguments: {
      facetVersionId: "00000000-0000-4000-8000-000000000099",
      input: { owner: "octocat", repo: "Hello-World" },
    },
  });
  if (!denied.isError || !JSON.stringify(denied).includes("Default-deny"))
    throw new Error(
      `Expected default-deny over MCP stdio, got: ${JSON.stringify(denied)}`,
    );

  const paid = (await invokeWithPayment({
    controlUrl: mockOrigin,
    gatewayUrl: mockOrigin,
    facetVersionId: versionId,
    input: { owner: "octocat", repo: "Hello-World" },
    idempotencyKey: "smoke-idempotency-key",
    runtime,
  })) as {
    status?: string;
    payment?: { snowtraceUrl?: string };
    receipt?: { snowtraceUrl?: string };
  };
  if (
    signedCalls !== 1 ||
    paid.status !== "SETTLED" ||
    paid.payment?.snowtraceUrl !==
      `https://testnet.snowtrace.io/tx/${paymentTx}` ||
    paid.receipt?.snowtraceUrl !==
      `https://testnet.snowtrace.io/tx/${receiptTx}`
  ) {
    throw new Error(`Unexpected paid smoke result: ${JSON.stringify(paid)}`);
  }

  process.stdout.write(
    "MCP stdio search, get_facet (<username>/<facet-name>), default-deny invoke, and x402 settlement smoke passed.\n",
  );
} finally {
  await client.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await rm(tempDir, { recursive: true, force: true });
}
