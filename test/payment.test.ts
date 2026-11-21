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
  type FacetPricingOption,
  type FujiRpcClient,
  type PricingModel,
  type PublicFacetRecord,
} from "@facet-aex/cli";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
} from "@x402/core/http";
import { verifyTypedData, getAddress, type Hex } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalBuyerRuntime } from "../src/local-wallet.js";
import {
  invokeWithPayment,
  validateChallengeForGrant,
} from "../src/payment.js";
import { createFacetMcpServer } from "../src/server.js";

const tempDirs: string[] = [];
const TEST_PRIVATE_KEY = ("0x" + "7".repeat(64)) as `0x${string}`;
const PROVIDER_PAY_TO = "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf" as const;
const PROVIDER = "tai-hung-dev";
const FACET_NAME = "echo-actor";
const FACET_DISPLAY_NAME = "Echo Actor";
const VERSION = "1.0.0";
const PUBLIC_ORIGIN = "https://facet.briandev.space";

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "facet-mcp-payment-test-"));
  tempDirs.push(dir);
  return dir;
}

function createMemoryBackend(initialKey?: string): CredentialBackend {
  const map = new Map<string, string>();
  if (initialKey) {
    map.set("space.briandev.facet.cli.wallet:default", initialKey);
  }
  return {
    async hasSecret(service, account) {
      return map.has(`${service}:${account}`);
    },
    async getSecret(service, account) {
      return map.get(`${service}:${account}`) ?? null;
    },
    async setSecret(service, account, secret) {
      map.set(`${service}:${account}`, secret);
    },
  };
}

function verifiedCatalogFacet(
  overrides?: Partial<PublicFacetRecord>,
): PublicFacetRecord {
  return {
    provider: PROVIDER,
    facetName: FACET_NAME,
    facetDisplayName: FACET_DISPLAY_NAME,
    version: VERSION,
    facetType: "ACTOR",
    pricing: {
      model: "PAY_PER_RUN",
      priceAtomic: "1000",
      assetAddress: FUSD_ASSET_ADDRESS,
      chainId: FUJI_CHAIN_ID,
      payTo: PROVIDER_PAY_TO,
    },
    actorMeta: {
      runtime: "nodejs22-alpine-v1",
      imageDigest: "sha256:" + "a".repeat(64),
      registryTxHash: "0x" + "1".repeat(64),
      registryVerified: true,
    },
    ...overrides,
  };
}

function makeChallengeHeader(overrides?: {
  network?: string;
  asset?: string;
  payTo?: string;
  amount?: string;
  resourceUrl?: string;
  providerPayTo?: string;
}) {
  const required = {
    x402Version: 2,
    resource: {
      url:
        overrides?.resourceUrl ??
        `${PUBLIC_ORIGIN}/v1/facets/${PROVIDER}/${FACET_NAME}/versions/${VERSION}/invoke?fingerprint=abc`,
    },
    accepts: [
      {
        scheme: "exact",
        network: overrides?.network ?? "eip155:43113",
        asset: overrides?.asset ?? FUSD_ASSET_ADDRESS,
        amount: overrides?.amount ?? "1000",
        payTo: overrides?.payTo ?? FACET_FEE_SPLIT_ADDRESS,
        maxTimeoutSeconds: 60,
        extra: {
          name: "FACET USD",
          version: "2",
          ...(overrides?.providerPayTo
            ? { providerPayTo: overrides.providerPayTo }
            : {}),
        },
      },
    ],
  };
  return encodePaymentRequiredHeader(required);
}

async function setupRuntime(options?: {
  balanceAtomic?: bigint;
  dailyCapAtomic?: string;
  maxPerRunAtomic?: string;
}) {
  const dir = await makeTempDir();
  const walletStore = new WalletStore({
    backend: createMemoryBackend(TEST_PRIVATE_KEY),
  });
  const policyStore = new PolicyStore({ filePath: join(dir, "policies.json") });
  const spendLedger = new SpendLedger({
    filePath: join(dir, "spend-ledger.json"),
  });
  const fujiClient: FujiRpcClient = {
    getChainId: vi.fn(async () => 43113),
    readFusdBalance: vi.fn(async () => options?.balanceAtomic ?? 100_000n),
  };

  const facet = verifiedCatalogFacet();
  await policyStore.grant({
    facet,
    maxPerRunAtomic: options?.maxPerRunAtomic ?? "1000",
    dailyCapAtomic: options?.dailyCapAtomic ?? "2000",
    expiresAt: "2030-01-01T00:00:00Z",
  });

  return {
    dir,
    facet,
    runtime: createLocalBuyerRuntime({
      walletStore,
      policyStore,
      spendLedger,
      fujiClient,
    }),
  };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("MCP local-wallet Option B x402 payment guard", () => {
  it("completes 402 -> 200 with Snowtrace links, confirms ledger, and omits UUIDs, legacy creator names, and raw secrets", async () => {
    const { facet, runtime } = await setupRuntime();
    const payerAddress = await runtime.walletStore.getWalletAddress();
    const paymentTx = "0x" + "2".repeat(64);
    const receiptTx = "0x" + "3".repeat(64);

    let invokeAttempt = 0;
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const href = String(url);
      if (
        href ===
        `${PUBLIC_ORIGIN}/v1/catalog/facets/${PROVIDER}/${FACET_NAME}/versions/${VERSION}`
      ) {
        return new Response(JSON.stringify({ facet }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (
        href ===
        `${PUBLIC_ORIGIN}/v1/facets/${PROVIDER}/${FACET_NAME}/versions/${VERSION}/invoke`
      ) {
        invokeAttempt += 1;
        if (invokeAttempt === 1) {
          // Omit extra.providerPayTo to match gateway/src/payment.ts production challenge
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": makeChallengeHeader(),
            },
          });
        }
        const headers = init?.headers as Record<string, string>;
        expect(headers["PAYMENT-SIGNATURE"]).toBeTruthy();
        return new Response(
          JSON.stringify({
            runId: "b55dcf50-5e15-42df-9cf6-a480efd5157d",
            provider: PROVIDER,
            facetName: FACET_NAME,
            facetDisplayName: FACET_DISPLAY_NAME,
            version: VERSION,
            facetType: "ACTOR",
            result: { items: [{ echo: "hi" }], count: 1 },
            dataset: [{ echo: "hi" }],
            usage: {
              itemCount: 1,
              durationMs: 25,
              outputHash: "sha256:" + "d".repeat(64),
              runnerSignature: "0x" + "ef".repeat(65),
            },
            replayed: false,
            payment: {
              transaction: paymentTx,
              network: "eip155:43113",
              amountAtomic: "1000",
              payer: payerAddress,
              providerPayTo: PROVIDER_PAY_TO,
            },
            receipt: {
              inputHash: "sha256:" + "e".repeat(64),
              outputHash: "sha256:" + "d".repeat(64),
              itemCount: 1,
              paymentTxHash: paymentTx,
              receiptTxHash: receiptTx,
              runnerSignature: "0x" + "ef".repeat(65),
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const out = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { text: "hi" },
      idempotencyKey: "key-1",
      runtime,
    })) as Record<string, unknown>;

    expect(out.status).toBe("SETTLED");
    expect(out.runId).toBe("b55dcf50-5e15-42df-9cf6-a480efd5157d");
    expect(out.provider).toBe(PROVIDER);
    expect(out.facetName).toBe(FACET_NAME);
    expect(out.facetDisplayName).toBe(FACET_DISPLAY_NAME);
    expect(out.version).toBe(VERSION);
    expect(out.facetType).toBe("ACTOR");
    const payment = out.payment as Record<string, unknown>;
    const receipt = out.receipt as Record<string, unknown>;
    expect(payment.amountAtomic).toBe("1000");
    expect(payment.payer).toBe(payerAddress);
    expect(payment.providerPayTo).toBe(PROVIDER_PAY_TO);
    expect(payment.snowtraceUrl).toBe(
      `https://testnet.snowtrace.io/tx/${paymentTx}`,
    );
    expect(receipt.receiptTxHash).toBe(receiptTx);
    expect(receipt.snowtraceUrl).toBe(
      `https://testnet.snowtrace.io/tx/${receiptTx}`,
    );

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(TEST_PRIVATE_KEY.slice(2));
    expect(serialized).not.toMatch(
      /facetId|versionId|facetVersionId|facetSlug|facetFullName|displayVersion|creatorPayTo|\bcreator\b|PAYMENT-SIGNATURE|HOSTED_ACTOR|AUTONOMOUS_AGENT|EXTERNAL_HTTP_API/u,
    );

    const entries = await runtime.spendLedger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("SETTLED");
    expect(entries[0]?.provider).toBe(PROVIDER);
    expect(entries[0]?.providerPayTo).toBe(PROVIDER_PAY_TO);
  });

  it("records actual PAY_PER_RESULT settled amount instead of max escrow deposit in SpendLedger", async () => {
    const dir = await makeTempDir();
    const walletStore = new WalletStore({
      backend: createMemoryBackend(TEST_PRIVATE_KEY),
    });
    const policyStore = new PolicyStore({
      filePath: join(dir, "policies.json"),
    });
    const spendLedger = new SpendLedger({
      filePath: join(dir, "spend-ledger.json"),
    });
    const fujiClient: FujiRpcClient = {
      getChainId: vi.fn(async () => 43113),
      readFusdBalance: vi.fn(async () => 100_000n),
    };
    const payPerResultFacet = verifiedCatalogFacet({
      pricing: {
        model: "PAY_PER_RESULT",
        priceAtomic: "500",
        assetAddress: FUSD_ASSET_ADDRESS,
        chainId: FUJI_CHAIN_ID,
        payTo: PROVIDER_PAY_TO,
      },
    });
    await policyStore.grant({
      facet: payPerResultFacet,
      maxPerRunAtomic: "10000",
      dailyCapAtomic: "10000",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    const runtime = createLocalBuyerRuntime({
      walletStore,
      policyStore,
      spendLedger,
      fujiClient,
    });
    const payerAddress = await walletStore.getWalletAddress();
    const paymentTx = "0x" + "8".repeat(64);
    const receiptTx = "0x" + "4".repeat(64);

    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet: payPerResultFacet }), {
            status: 200,
          });
        }
        attempt += 1;
        if (attempt === 1) {
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": makeChallengeHeader({ amount: "10000" }),
            },
          });
        }
        return new Response(
          JSON.stringify({
            runId: "cfa3c216-b707-47c8-b6aa-e53a3b9fa18c",
            provider: PROVIDER,
            facetName: FACET_NAME,
            facetDisplayName: FACET_DISPLAY_NAME,
            version: VERSION,
            facetType: "ACTOR",
            result: { items: [{ title: "ok" }], count: 1 },
            dataset: [{ title: "ok" }],
            replayed: false,
            payment: {
              transaction: paymentTx,
              network: "eip155:43113",
              amountAtomic: "500",
              payer: payerAddress,
              providerPayTo: PROVIDER_PAY_TO,
            },
            receipt: {
              inputHash: "sha256:" + "a".repeat(64),
              outputHash: "sha256:" + "b".repeat(64),
              itemCount: 1,
              paymentTxHash: paymentTx,
              receiptTxHash: receiptTx,
              runnerSignature: "0x" + "ef".repeat(65),
            },
          }),
          { status: 200 },
        );
      }),
    );

    const out = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { limit: 1 },
      idempotencyKey: "key-pay-per-result",
      runtime,
    })) as { payment: { amountAtomic: string; amountFormatted: string } };

    expect(out.payment.amountAtomic).toBe("500");
    expect(out.payment.amountFormatted).toBe("0.000500");
    const entries = await runtime.spendLedger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("SETTLED");
    expect(entries[0]?.amountAtomic).toBe("500");
  });

  it("denies invalid identifiers, wrong chain, asset, fee-split payTo, provider recipient, challenge resource path, amount, and ungranted versions before signing", async () => {
    const { runtime } = await setupRuntime();
    const target = {
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
    };
    const grant = (await runtime.policyStore.findGrant(
      PROVIDER,
      FACET_NAME,
      VERSION,
    ))!;

    function expectErrorCode(fn: () => unknown, code: string) {
      let caught: unknown;
      try {
        fn();
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ code });
    }

    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        provider: PROVIDER,
        facetName: FACET_NAME,
        version: "v1",
        input: { text: "hi" },
        idempotencyKey: "key-bad-ver",
        runtime,
      }),
    ).rejects.toMatchObject({ code: "POLICY_INVALID" });

    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        provider: "tai_hung",
        facetName: FACET_NAME,
        version: VERSION,
        input: { text: "hi" },
        idempotencyKey: "key-bad-provider",
        runtime,
      }),
    ).rejects.toMatchObject({ code: "POLICY_INVALID" });

    expectErrorCode(
      () =>
        validateChallengeForGrant(
          makeChallengeHeader({ network: "eip155:43114" }),
          grant,
          target,
        ),
      "POLICY_CHAIN_MISMATCH",
    );

    expectErrorCode(
      () =>
        validateChallengeForGrant(
          makeChallengeHeader({
            asset: "0x0000000000000000000000000000000000000099",
          }),
          grant,
          target,
        ),
      "POLICY_ASSET_MISMATCH",
    );

    expectErrorCode(
      () =>
        validateChallengeForGrant(
          makeChallengeHeader({
            payTo: "0x0000000000000000000000000000000000000099",
          }),
          grant,
          target,
        ),
      "POLICY_RECIPIENT_MISMATCH",
    );

    expectErrorCode(
      () =>
        validateChallengeForGrant(
          makeChallengeHeader({
            providerPayTo: "0x0000000000000000000000000000000000000099",
          }),
          grant,
          target,
        ),
      "POLICY_RECIPIENT_MISMATCH",
    );

    expectErrorCode(
      () =>
        validateChallengeForGrant(
          makeChallengeHeader({
            resourceUrl: `${PUBLIC_ORIGIN}/v1/facets/${PROVIDER}/${FACET_NAME}/versions/1.0.1/invoke`,
          }),
          grant,
          target,
        ),
      "PAYMENT_CHALLENGE_NOT_ALLOWED",
    );

    expectErrorCode(
      () =>
        validateChallengeForGrant(
          makeChallengeHeader({ amount: "1500" }),
          grant,
          target,
        ),
      "POLICY_MAX_PER_RUN_EXCEEDED",
    );

    // Ungranted SemVer version denied (default-deny)
    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        provider: PROVIDER,
        facetName: FACET_NAME,
        version: "1.0.1",
        input: { text: "hi" },
        idempotencyKey: "key-denied",
        runtime,
      }),
    ).rejects.toMatchObject({ code: "POLICY_NOT_GRANTED" });
  });

  it("rejects insufficient balance before reserving or signing", async () => {
    const { facet, runtime } = await setupRuntime({ balanceAtomic: 500n });
    const fetchMock = vi.fn(async (url: URL | string) => {
      if (String(url).includes("/v1/catalog/facets/")) {
        return new Response(JSON.stringify({ facet }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "payment_required" }), {
        status: 402,
        headers: { "PAYMENT-REQUIRED": makeChallengeHeader() },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        provider: PROVIDER,
        facetName: FACET_NAME,
        version: VERSION,
        input: { text: "hi" },
        idempotencyKey: "key-low-bal",
        runtime,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUSD_BALANCE" });

    expect(await runtime.spendLedger.list()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains and re-submits PAYMENT-SIGNATURE across 202 and timeout retries without re-signing, releases on 409 conflict, and replays without second charge", async () => {
    const { facet, runtime } = await setupRuntime({ dailyCapAtomic: "1000" });
    const paymentTx = "0x" + "5".repeat(64);
    const receiptTx = "0x" + "6".repeat(64);
    const signSpy = vi.spyOn(x402Client.prototype, "createPaymentPayload");
    const sentSignatures: string[] = [];

    let mode: "202" | "timeout" | "409" | "200" = "202";
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/v1/catalog/facets/")) {
        return new Response(JSON.stringify({ facet }), { status: 200 });
      }
      const sig = (init?.headers as Record<string, string> | undefined)?.[
        "PAYMENT-SIGNATURE"
      ];
      if (!sig) {
        return new Response(JSON.stringify({ error: "payment_required" }), {
          status: 402,
          headers: { "PAYMENT-REQUIRED": makeChallengeHeader() },
        });
      }
      sentSignatures.push(sig);
      if (mode === "202") {
        return new Response(
          JSON.stringify({
            runId: "b55dcf50-5e15-42df-9cf6-a480efd5157d",
            provider: PROVIDER,
            facetName: FACET_NAME,
            version: VERSION,
            payment: { status: "settlement_pending", transaction: paymentTx },
          }),
          { status: 202 },
        );
      }
      if (mode === "timeout") {
        throw new DOMException("Timed out", "TimeoutError");
      }
      if (mode === "409") {
        return new Response(
          JSON.stringify({ error: { code: "IDEMPOTENCY_CONFLICT" } }),
          { status: 409 },
        );
      }
      return new Response(
        JSON.stringify({
          runId: "b55dcf50-5e15-42df-9cf6-a480efd5157d",
          provider: PROVIDER,
          facetName: FACET_NAME,
          facetDisplayName: FACET_DISPLAY_NAME,
          version: VERSION,
          facetType: "ACTOR",
          result: { ok: true },
          dataset: [{ ok: true }],
          replayed: true,
          payment: {
            transaction: paymentTx,
            network: "eip155:43113",
            amountAtomic: "1000",
            payer: await runtime.walletStore.getWalletAddress(),
            providerPayTo: PROVIDER_PAY_TO,
          },
          receipt: {
            inputHash: "sha256:" + "a".repeat(64),
            outputHash: "sha256:" + "b".repeat(64),
            itemCount: 1,
            paymentTxHash: paymentTx,
            receiptTxHash: receiptTx,
            runnerSignature: "0x" + "ef".repeat(65),
          },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    // 1) Initial call hits 402 -> signs once -> receives 202 pending
    const pending202 = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { b: 2, a: 1 },
      idempotencyKey: "key-pending",
      runtime,
    })) as Record<string, unknown>;
    expect(pending202.status).toBe("PENDING");
    expect(pending202.provider).toBe(PROVIDER);
    expect(pending202.facetName).toBe(FACET_NAME);
    expect(pending202.version).toBe(VERSION);
    expect(pending202.receipt).toBeUndefined();
    expect((await runtime.spendLedger.list())[0]?.status).toBe("PENDING");
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(sentSignatures).toHaveLength(1);

    // Different key hits daily cap while key-pending is still PENDING
    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        provider: PROVIDER,
        facetName: FACET_NAME,
        version: VERSION,
        input: { text: "other" },
        idempotencyKey: "key-second",
        runtime,
      }),
    ).rejects.toMatchObject({ code: "DAILY_CAP_EXCEEDED" });

    // 2) Timeout on retry with same key & canonically equivalent key ordering re-uses exact PAYMENT-SIGNATURE without re-signing
    mode = "timeout";
    const pendingTimeout = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { a: 1, b: 2 },
      idempotencyKey: "key-pending",
      runtime,
    })) as Record<string, unknown>;
    expect(pendingTimeout.status).toBe("PENDING");
    expect((await runtime.spendLedger.list())[0]?.status).toBe("PENDING");
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(sentSignatures).toHaveLength(2);
    expect(sentSignatures[1]).toBe(sentSignatures[0]);

    // 3) Same-key retry succeeds (200) using exact retained PAYMENT-SIGNATURE & settles single ledger entry
    mode = "200";
    const settled = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { a: 1, b: 2 },
      idempotencyKey: "key-pending",
      runtime,
    })) as Record<string, unknown>;
    expect(settled.replayed).toBe(true);
    expect(await runtime.spendLedger.list()).toHaveLength(1);
    expect((await runtime.spendLedger.list())[0]?.status).toBe("SETTLED");
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(sentSignatures).toHaveLength(3);
    expect(sentSignatures[2]).toBe(sentSignatures[0]);

    // 4) Replay again after SETTLED still uses retained PAYMENT-SIGNATURE without re-signing
    const settledReplay = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { a: 1, b: 2 },
      idempotencyKey: "key-pending",
      runtime,
    })) as Record<string, unknown>;
    expect(settledReplay.replayed).toBe(true);
    expect(await runtime.spendLedger.list()).toHaveLength(1);
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(sentSignatures).toHaveLength(4);
    expect(sentSignatures[3]).toBe(sentSignatures[0]);

    // 5) 409 conflict on a new key releases reservation cleanly
    const { runtime: conflictRuntime, facet: conflictFacet } =
      await setupRuntime();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet: conflictFacet }), {
            status: 200,
          });
        }
        const hasSig = Boolean(
          (init?.headers as Record<string, string> | undefined)?.[
            "PAYMENT-SIGNATURE"
          ],
        );
        if (!hasSig) {
          return new Response("pay", {
            status: 402,
            headers: { "PAYMENT-REQUIRED": makeChallengeHeader() },
          });
        }
        return new Response(
          JSON.stringify({ error: { code: "IDEMPOTENCY_CONFLICT" } }),
          { status: 409 },
        );
      }),
    );

    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        provider: PROVIDER,
        facetName: FACET_NAME,
        version: VERSION,
        input: { text: "changed" },
        idempotencyKey: "key-conflict",
        runtime: conflictRuntime,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await conflictRuntime.spendLedger.list())[0]?.status).toBe(
      "RELEASED",
    );
  });

  it("exposes Option B MCP tools (search_facets, get_facet, invoke_facet) over InMemoryTransport", async () => {
    const { facet, runtime } = await setupRuntime();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string) => {
        const href = String(url);
        if (href.startsWith(`${PUBLIC_ORIGIN}/v1/catalog/facets?`)) {
          expect(href).toContain("type=ACTOR");
          expect(href).toContain("limit=5");
          return new Response(JSON.stringify({ facets: [facet] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (
          href ===
          `${PUBLIC_ORIGIN}/v1/catalog/facets/${PROVIDER}/${FACET_NAME}/versions/${VERSION}`
        ) {
          return new Response(JSON.stringify({ facet }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const server = createFacetMcpServer({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      runtime,
    });
    const client = new Client({ name: "mcp-unit-client", version: "0.2.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const listed = await client.listTools();
      const invokeTool = listed.tools.find((t) => t.name === "invoke_facet");
      const getTool = listed.tools.find((t) => t.name === "get_facet");
      const searchTool = listed.tools.find((t) => t.name === "search_facets");

      expect(Object.keys(getTool?.inputSchema.properties ?? {})).toEqual(
        expect.arrayContaining(["provider", "facetName", "version"]),
      );
      expect(Object.keys(invokeTool?.inputSchema.properties ?? {})).toEqual(
        expect.arrayContaining([
          "provider",
          "facetName",
          "version",
          "input",
          "idempotencyKey",
        ]),
      );
      expect(JSON.stringify(searchTool?.inputSchema)).toContain('"ACTOR"');
      expect(JSON.stringify(searchTool?.inputSchema)).not.toContain(
        "HOSTED_ACTOR",
      );

      const searched = await client.callTool({
        name: "search_facets",
        arguments: { query: "echo", type: "ACTOR", limit: 5 },
      });
      expect(JSON.stringify(searched)).toContain(FACET_DISPLAY_NAME);

      const fetched = await client.callTool({
        name: "get_facet",
        arguments: {
          provider: PROVIDER,
          facetName: FACET_NAME,
          version: VERSION,
        },
      });
      const fetchedContent = fetched.content as Array<{ text: string }>;
      const fetchedBody = JSON.parse(fetchedContent[0]!.text) as {
        facet: { provider: string; facetName: string; version: string };
      };
      expect(fetchedBody.facet.provider).toBe(PROVIDER);
      expect(fetchedBody.facet.facetName).toBe(FACET_NAME);
      expect(fetchedBody.facet.version).toBe(VERSION);

      const props = invokeTool?.inputSchema.properties as
        Record<string, { enum?: string[] }> | undefined;
      expect(props?.pricingModel?.enum).toEqual([
        "PAY_PER_RUN",
        "PAY_PER_RESULT",
      ]);

      const instructions = client.getInstructions() ?? "";
      expect(instructions).not.toMatch(/\bfuji\b/iu);
      expect(instructions).toContain("pricingOptions");
      expect(instructions).toContain("apiMeta");
      expect(instructions).toContain("pricingModel?");
      for (const tool of [searchTool, getTool, invokeTool]) {
        expect(tool?.description ?? "").not.toMatch(/\bfuji\b/iu);
      }
      expect(getTool?.description ?? "").toContain("pricingOptions");
      expect(getTool?.description ?? "").toContain("apiMeta");
      expect(invokeTool?.description ?? "").toContain("pricingModel?");
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});

function makePricingOptions(): FacetPricingOption[] {
  return [
    {
      model: "PAY_PER_RUN",
      priceAtomic: "1000",
      maxAmountAtomic: "1000",
      assetAddress: FUSD_ASSET_ADDRESS,
      chainId: FUJI_CHAIN_ID,
      payTo: PROVIDER_PAY_TO,
      isPrimary: true,
    },
    {
      model: "PAY_PER_RESULT",
      priceAtomic: "500",
      maxItemsCap: 10,
      maxAmountAtomic: "5000",
      assetAddress: FUSD_ASSET_ADDRESS,
      chainId: FUJI_CHAIN_ID,
      payTo: PROVIDER_PAY_TO,
      isPrimary: false,
    },
  ];
}

function makeAcceptEntry(options: {
  pricingModel?: PricingModel | string;
  unitPriceAtomic?: unknown;
  maxItemsCap?: unknown;
  amount: string;
  providerPayTo?: unknown;
  payTo?: string;
  asset?: string;
  network?: string;
  omitPricingExtra?: boolean;
}) {
  return {
    scheme: "exact",
    network: options.network ?? "eip155:43113",
    asset: options.asset ?? FUSD_ASSET_ADDRESS,
    amount: options.amount,
    payTo: options.payTo ?? FACET_FEE_SPLIT_ADDRESS,
    maxTimeoutSeconds: 60,
    extra: options.omitPricingExtra
      ? {
          name: "FACET USD",
          version: "2",
        }
      : {
          name: "FACET USD",
          version: "2",
          ...(options.pricingModel !== undefined
            ? { pricingModel: options.pricingModel }
            : {}),
          ...(options.unitPriceAtomic !== undefined
            ? { unitPriceAtomic: options.unitPriceAtomic }
            : {}),
          ...(options.maxItemsCap !== undefined
            ? { maxItemsCap: options.maxItemsCap }
            : {}),
          providerPayTo: options.providerPayTo ?? PROVIDER_PAY_TO,
        },
  };
}

function makeMultiChallengeHeader(
  accepts: Array<ReturnType<typeof makeAcceptEntry>>,
  resourceUrl?: string,
) {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    resource: {
      url:
        resourceUrl ??
        `${PUBLIC_ORIGIN}/v1/facets/${PROVIDER}/${FACET_NAME}/versions/${VERSION}/invoke`,
    },
    accepts,
  });
}

async function setupMultiPricingRuntime(options?: {
  facetOverrides?: Partial<PublicFacetRecord>;
  pricingModelFilter?: PricingModel;
  maxPerRunAtomic?: string;
  dailyCapAtomic?: string;
  balanceAtomic?: bigint;
}) {
  const dir = await makeTempDir();
  const walletStore = new WalletStore({
    backend: createMemoryBackend(TEST_PRIVATE_KEY),
  });
  const policyStore = new PolicyStore({
    filePath: join(dir, "policies.json"),
  });
  const spendLedger = new SpendLedger({
    filePath: join(dir, "spend-ledger.json"),
  });
  const fujiClient: FujiRpcClient = {
    getChainId: vi.fn(async () => 43113),
    readFusdBalance: vi.fn(async () => options?.balanceAtomic ?? 100_000n),
  };

  const pricingOptions = makePricingOptions();
  const facet = verifiedCatalogFacet({
    pricing: pricingOptions[0],
    pricingOptions,
    ...options?.facetOverrides,
  });
  const grant = await policyStore.grant({
    facet,
    ...(options?.pricingModelFilter
      ? { pricingModel: options.pricingModelFilter }
      : {}),
    maxPerRunAtomic: options?.maxPerRunAtomic ?? "10000",
    dailyCapAtomic: options?.dailyCapAtomic ?? "50000",
    expiresAt: "2030-01-01T00:00:00Z",
  });

  return {
    dir,
    facet,
    grant,
    runtime: createLocalBuyerRuntime({
      walletStore,
      policyStore,
      spendLedger,
      fujiClient,
    }),
  };
}

describe("MCP multi-pricing, TaskEscrow, verified API, and 502 refund handling", () => {
  it("selects PAY_PER_RESULT from a 2-entry accepts[] challenge, disambiguates equal amounts, narrows to 1 entry before signing, and rejects tampered extra metadata", async () => {
    const { facet, grant, runtime } = await setupMultiPricingRuntime();
    const target = {
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
    };

    const twoOptionHeader = makeMultiChallengeHeader([
      makeAcceptEntry({
        pricingModel: "PAY_PER_RUN",
        unitPriceAtomic: "1000",
        amount: "1000",
      }),
      makeAcceptEntry({
        pricingModel: "PAY_PER_RESULT",
        unitPriceAtomic: "500",
        maxItemsCap: 10,
        amount: "5000",
      }),
    ]);
    const twoOptionRequired = decodePaymentRequiredHeader(twoOptionHeader);

    const validated = validateChallengeForGrant(
      grant,
      twoOptionRequired,
      target,
      "PAY_PER_RESULT",
    );
    expect(validated.narrowedRequired.accepts).toHaveLength(1);
    expect(validated.selectedOption.amount).toBe("5000");
    expect(validated.selectedOption.extra.pricingModel).toBe("PAY_PER_RESULT");
    expect(validated.pricingModel).toBe("PAY_PER_RESULT");
    expect(validated.unitPriceAtomic).toBe("500");
    expect(validated.maxItemsCap).toBe(10);

    // Omitting requestedPricingModel selects primary matching granted option (PAY_PER_RUN)
    const defaultPrimary = validateChallengeForGrant(
      grant,
      twoOptionRequired,
      target,
    );
    expect(defaultPrimary.narrowedRequired.accepts).toHaveLength(1);
    expect(defaultPrimary.pricingModel).toBe("PAY_PER_RUN");

    // Equal-amount disambiguation (10000 vs 500 * 20 = 10000)
    const equalTarget = {
      provider: PROVIDER,
      facetName: "equal-amount-actor",
      version: VERSION,
    };
    const equalFacet = verifiedCatalogFacet({
      facetName: equalTarget.facetName,
      pricing: {
        model: "PAY_PER_RUN",
        priceAtomic: "10000",
        maxAmountAtomic: "10000",
        assetAddress: FUSD_ASSET_ADDRESS,
        chainId: FUJI_CHAIN_ID,
        payTo: PROVIDER_PAY_TO,
        isPrimary: true,
      },
      pricingOptions: [
        {
          model: "PAY_PER_RUN",
          priceAtomic: "10000",
          maxAmountAtomic: "10000",
          assetAddress: FUSD_ASSET_ADDRESS,
          chainId: FUJI_CHAIN_ID,
          payTo: PROVIDER_PAY_TO,
          isPrimary: true,
        },
        {
          model: "PAY_PER_RESULT",
          priceAtomic: "500",
          maxItemsCap: 20,
          maxAmountAtomic: "10000",
          assetAddress: FUSD_ASSET_ADDRESS,
          chainId: FUJI_CHAIN_ID,
          payTo: PROVIDER_PAY_TO,
          isPrimary: false,
        },
      ],
    });
    const equalGrant = await runtime.policyStore.grant({
      facet: equalFacet,
      maxPerRunAtomic: "10000",
      dailyCapAtomic: "50000",
      expiresAt: "2030-01-01T00:00:00Z",
    });
    const equalRequired = decodePaymentRequiredHeader(
      makeMultiChallengeHeader(
        [
          makeAcceptEntry({
            pricingModel: "PAY_PER_RUN",
            unitPriceAtomic: "10000",
            amount: "10000",
          }),
          makeAcceptEntry({
            pricingModel: "PAY_PER_RESULT",
            unitPriceAtomic: "500",
            maxItemsCap: 20,
            amount: "10000",
          }),
        ],
        `${PUBLIC_ORIGIN}/v1/facets/${PROVIDER}/${equalTarget.facetName}/versions/${VERSION}/invoke`,
      ),
    );
    const disambiguated = validateChallengeForGrant(
      equalGrant,
      equalRequired,
      equalTarget,
      "PAY_PER_RESULT",
    );
    expect(disambiguated.narrowedRequired.accepts).toHaveLength(1);
    expect(disambiguated.narrowedRequired.accepts[0]?.extra.pricingModel).toBe(
      "PAY_PER_RESULT",
    );
    expect(disambiguated.unitPriceAtomic).toBe("500");
    expect(disambiguated.maxItemsCap).toBe(20);

    // Single-option grant selects matching granted option when requestedPricingModel is omitted
    const { grant: resultOnlyGrant } = await setupMultiPricingRuntime({
      pricingModelFilter: "PAY_PER_RESULT",
    });
    const selectedFromSingleGrant = validateChallengeForGrant(
      resultOnlyGrant,
      twoOptionRequired,
      target,
    );
    expect(selectedFromSingleGrant.narrowedRequired.accepts).toHaveLength(1);
    expect(selectedFromSingleGrant.pricingModel).toBe("PAY_PER_RESULT");
    expect(selectedFromSingleGrant.maxItemsCap).toBe(10);

    // Rejects tampered unitPriceAtomic, maxItemsCap, amount, duplicate/ambiguous, and unoffered options
    expect(() =>
      validateChallengeForGrant(
        grant,
        decodePaymentRequiredHeader(
          makeMultiChallengeHeader([
            makeAcceptEntry({
              pricingModel: "PAY_PER_RESULT",
              unitPriceAtomic: "600",
              maxItemsCap: 10,
              amount: "5000",
            }),
          ]),
        ),
        target,
        "PAY_PER_RESULT",
      ),
    ).toThrow(/unitPriceAtomic/u);

    expect(() =>
      validateChallengeForGrant(
        grant,
        decodePaymentRequiredHeader(
          makeMultiChallengeHeader([
            makeAcceptEntry({
              pricingModel: "PAY_PER_RESULT",
              unitPriceAtomic: 500,
              maxItemsCap: 10,
              amount: "5000",
            }),
          ]),
        ),
        target,
        "PAY_PER_RESULT",
      ),
    ).toThrow(/unitPriceAtomic/u);

    expect(() =>
      validateChallengeForGrant(
        grant,
        decodePaymentRequiredHeader(
          makeMultiChallengeHeader([
            makeAcceptEntry({
              pricingModel: "PAY_PER_RESULT",
              unitPriceAtomic: "500",
              maxItemsCap: 11,
              amount: "5000",
            }),
          ]),
        ),
        target,
        "PAY_PER_RESULT",
      ),
    ).toThrow(/maxItemsCap/u);

    expect(() =>
      validateChallengeForGrant(
        grant,
        decodePaymentRequiredHeader(
          makeMultiChallengeHeader([
            makeAcceptEntry({
              pricingModel: "PAY_PER_RESULT",
              unitPriceAtomic: "500",
              maxItemsCap: "10",
              amount: "5000",
            }),
          ]),
        ),
        target,
        "PAY_PER_RESULT",
      ),
    ).toThrow(/maxItemsCap/u);

    expect(() =>
      validateChallengeForGrant(
        grant,
        decodePaymentRequiredHeader(
          makeMultiChallengeHeader([
            makeAcceptEntry({
              pricingModel: "PAY_PER_RUN",
              unitPriceAtomic: "1000",
              maxItemsCap: 10,
              amount: "1000",
            }),
          ]),
        ),
        target,
        "PAY_PER_RUN",
      ),
    ).toThrow(/maxItemsCap/u);

    expect(() =>
      validateChallengeForGrant(
        grant,
        decodePaymentRequiredHeader(
          makeMultiChallengeHeader([
            makeAcceptEntry({
              pricingModel: "PAY_PER_RESULT",
              unitPriceAtomic: "500",
              maxItemsCap: 10,
              amount: "6000",
            }),
          ]),
        ),
        target,
        "PAY_PER_RESULT",
      ),
    ).toThrow(/maxAmountAtomic|5000/u);

    expect(() =>
      validateChallengeForGrant(
        grant,
        decodePaymentRequiredHeader(
          makeMultiChallengeHeader([
            makeAcceptEntry({
              pricingModel: "PAY_PER_RUN",
              unitPriceAtomic: "1000",
              amount: "1000",
            }),
          ]),
        ),
        target,
        "PAY_PER_RESULT",
      ),
    ).toThrow(/does not offer requested pricingModel/u);

    expect(() =>
      validateChallengeForGrant(
        grant,
        decodePaymentRequiredHeader(
          makeMultiChallengeHeader([
            makeAcceptEntry({
              pricingModel: "PAY_PER_RUN",
              unitPriceAtomic: "1000",
              amount: "1000",
            }),
            makeAcceptEntry({
              pricingModel: "PAY_PER_RUN",
              unitPriceAtomic: "1000",
              amount: "1000",
            }),
          ]),
        ),
        target,
      ),
    ).toThrow(/duplicate pricingModel/u);

    expect(() =>
      validateChallengeForGrant(
        grant,
        decodePaymentRequiredHeader(
          makeMultiChallengeHeader([
            makeAcceptEntry({ amount: "1000", omitPricingExtra: true }),
            makeAcceptEntry({ amount: "5000", omitPricingExtra: true }),
          ]),
        ),
        target,
      ),
    ).toThrow(/missing a valid pricingModel/u);

    // Verify invokeWithPayment sends pricingModel in body and passes narrowed 1-entry accepts[] to createPaymentPayload
    const signSpy = vi.spyOn(x402Client.prototype, "createPaymentPayload");
    const payerAddress = await runtime.walletStore.getWalletAddress();
    const paymentTx = "0x" + "2".repeat(64);
    const depositTx = "0x" + "1".repeat(64);
    const receiptTx = "0x" + "3".repeat(64);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        const href = String(url);
        if (href.includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet }), { status: 200 });
        }
        const parsedBody = JSON.parse(String(init?.body ?? "{}")) as {
          pricingModel?: string;
        };
        expect(parsedBody.pricingModel).toBe("PAY_PER_RESULT");
        const sig = (init?.headers as Record<string, string> | undefined)?.[
          "PAYMENT-SIGNATURE"
        ];
        if (!sig) {
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: { "PAYMENT-REQUIRED": twoOptionHeader },
          });
        }
        return new Response(
          JSON.stringify({
            runId: "b55dcf50-5e15-42df-9cf6-a480efd5157d",
            provider: PROVIDER,
            facetName: FACET_NAME,
            facetDisplayName: FACET_DISPLAY_NAME,
            version: VERSION,
            facetType: "ACTOR",
            result: { items: [{ a: 1 }, { a: 2 }, { a: 3 }], count: 3 },
            dataset: [{ a: 1 }, { a: 2 }, { a: 3 }],
            usage: {
              itemCount: 3,
              durationMs: 25,
              outputHash: "sha256:" + "d".repeat(64),
              runnerSignature: "0x" + "ef".repeat(65),
            },
            replayed: false,
            payment: {
              transaction: paymentTx,
              network: "eip155:43113",
              pricingModel: "PAY_PER_RESULT",
              amountAtomic: "1500",
              unitPriceAtomic: "500",
              maxItemsCap: 10,
              depositedAmountAtomic: "5000",
              refundAmountAtomic: "3500",
              depositTxHash: depositTx,
              payer: payerAddress,
              providerPayTo: PROVIDER_PAY_TO,
            },
            receipt: {
              inputHash: "sha256:" + "e".repeat(64),
              outputHash: "sha256:" + "d".repeat(64),
              itemCount: 3,
              paymentTxHash: paymentTx,
              receiptTxHash: receiptTx,
              runnerSignature: "0x" + "ef".repeat(65),
            },
          }),
          { status: 200 },
        );
      }),
    );

    const out = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { limit: 3 },
      pricingModel: "PAY_PER_RESULT",
      idempotencyKey: "key-multi-select",
      runtime,
    })) as {
      payment: Record<string, unknown>;
    };

    expect(signSpy).toHaveBeenCalledTimes(1);
    const passedRequired = signSpy.mock.calls[0]![0] as {
      accepts: Array<{ extra?: Record<string, unknown> }>;
    };
    expect(passedRequired.accepts).toHaveLength(1);
    expect(passedRequired.accepts[0]?.extra?.pricingModel).toBe(
      "PAY_PER_RESULT",
    );

    expect(out.payment.pricingModel).toBe("PAY_PER_RESULT");
    expect(out.payment.amountAtomic).toBe("1500");
    expect(out.payment.amountFormatted).toBe("0.001500");
    expect(out.payment.depositedAmountAtomic).toBe("5000");
    expect(out.payment.depositedAmountFormatted).toBe("0.005000");
    expect(out.payment.refundAmountAtomic).toBe("3500");
    expect(out.payment.refundAmountFormatted).toBe("0.003500");
    expect(out.payment.depositTxHash).toBe(depositTx);
    expect(out.payment.depositSnowtraceUrl).toBe(
      `https://testnet.snowtrace.io/tx/${depositTx}`,
    );

    const entries = await runtime.spendLedger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: "SETTLED",
      pricingModel: "PAY_PER_RESULT",
      amountAtomic: "1500",
      depositedAmountAtomic: "5000",
      refundAmountAtomic: "3500",
      itemCount: 3,
      depositTxHash: depositTx,
    });
  });

  it("handles itemCount === 0 PAY_PER_RESULT settlement (amountAtomic: '0', 100% refund) in SpendLedger and response", async () => {
    const { facet, runtime } = await setupMultiPricingRuntime({
      pricingModelFilter: "PAY_PER_RESULT",
    });
    const payerAddress = await runtime.walletStore.getWalletAddress();
    const paymentTx = "0x" + "2".repeat(64);
    const depositTx = "0x" + "1".repeat(64);
    const receiptTx = "0x" + "3".repeat(64);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet }), { status: 200 });
        }
        const sig = (init?.headers as Record<string, string> | undefined)?.[
          "PAYMENT-SIGNATURE"
        ];
        if (!sig) {
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": makeMultiChallengeHeader([
                makeAcceptEntry({
                  pricingModel: "PAY_PER_RESULT",
                  unitPriceAtomic: "500",
                  maxItemsCap: 10,
                  amount: "5000",
                }),
              ]),
            },
          });
        }
        return new Response(
          JSON.stringify({
            runId: "b55dcf50-5e15-42df-9cf6-a480efd5157e",
            provider: PROVIDER,
            facetName: FACET_NAME,
            facetDisplayName: FACET_DISPLAY_NAME,
            version: VERSION,
            facetType: "ACTOR",
            result: { items: [], count: 0 },
            dataset: [],
            usage: {
              itemCount: 0,
              durationMs: 12,
              outputHash: "sha256:" + "d".repeat(64),
              runnerSignature: "0x" + "ef".repeat(65),
            },
            replayed: false,
            payment: {
              transaction: paymentTx,
              network: "eip155:43113",
              pricingModel: "PAY_PER_RESULT",
              amountAtomic: "0",
              unitPriceAtomic: "500",
              maxItemsCap: 10,
              depositedAmountAtomic: "5000",
              refundAmountAtomic: "5000",
              depositTxHash: depositTx,
              payer: payerAddress,
              providerPayTo: PROVIDER_PAY_TO,
            },
            receipt: {
              inputHash: "sha256:" + "e".repeat(64),
              outputHash: "sha256:" + "d".repeat(64),
              itemCount: 0,
              paymentTxHash: paymentTx,
              receiptTxHash: receiptTx,
              runnerSignature: "0x" + "ef".repeat(65),
            },
          }),
          { status: 200 },
        );
      }),
    );

    const out = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { limit: 0 },
      pricingModel: "PAY_PER_RESULT",
      idempotencyKey: "key-zero-items",
      runtime,
    })) as {
      payment: Record<string, unknown>;
    };

    expect(out.payment.amountAtomic).toBe("0");
    expect(out.payment.amountFormatted).toBe("0.000000");
    expect(out.payment.depositedAmountAtomic).toBe("5000");
    expect(out.payment.refundAmountAtomic).toBe("5000");
    expect(out.payment.depositSnowtraceUrl).toBe(
      `https://testnet.snowtrace.io/tx/${depositTx}`,
    );

    const entries = await runtime.spendLedger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: "SETTLED",
      pricingModel: "PAY_PER_RESULT",
      amountAtomic: "0",
      depositedAmountAtomic: "5000",
      refundAmountAtomic: "5000",
      itemCount: 0,
      depositTxHash: depositTx,
    });
  });

  it("supports verified API facets and rejects unverified API or mismatched registryTxHash with Avalanche copy", async () => {
    const { facet: apiFacet, runtime } = await setupMultiPricingRuntime({
      facetOverrides: {
        facetType: "API",
        actorMeta: undefined,
        apiMeta: {
          method: "GET",
          pathTemplate: "/v1/items",
          datasetPath: "items",
          registryTxHash: "0x" + "1".repeat(64),
          registryVerified: true,
        },
      },
      balanceAtomic: 100n,
    });

    // Low balance error must say Avalanche, never Fuji
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet: apiFacet }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ error: "payment_required" }), {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": makeMultiChallengeHeader([
              makeAcceptEntry({
                pricingModel: "PAY_PER_RUN",
                unitPriceAtomic: "1000",
                amount: "1000",
              }),
            ]),
          },
        });
      }),
    );

    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        provider: PROVIDER,
        facetName: FACET_NAME,
        version: VERSION,
        input: { q: "btc" },
        idempotencyKey: "key-api-low-bal",
        runtime,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { code?: string; message?: string };
      return (
        e.code === "INSUFFICIENT_FUSD_BALANCE" &&
        !/\bfuji\b/iu.test(e.message ?? "") &&
        /Avalanche/u.test(e.message ?? "")
      );
    });

    // Unverified API in catalog must reject with UNVERIFIED_FACET_REGISTRY and Avalanche copy
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(
            JSON.stringify({
              facet: {
                ...apiFacet,
                apiMeta: { ...apiFacet.apiMeta, registryVerified: false },
              },
            }),
            { status: 200 },
          );
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        provider: PROVIDER,
        facetName: FACET_NAME,
        version: VERSION,
        input: { q: "btc" },
        idempotencyKey: "key-api-unverified",
        runtime,
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const e = err as { code?: string; message?: string };
      return (
        e.code === "UNVERIFIED_FACET_REGISTRY" &&
        !/\bfuji\b/iu.test(e.message ?? "") &&
        /Avalanche/u.test(e.message ?? "")
      );
    });

    // Mismatched registryTxHash in catalog must reject with FACET_CATALOG_MISMATCH
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(
            JSON.stringify({
              facet: {
                ...apiFacet,
                apiMeta: {
                  ...apiFacet.apiMeta,
                  registryTxHash: "0x" + "f".repeat(64),
                },
              },
            }),
            { status: 200 },
          );
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        provider: PROVIDER,
        facetName: FACET_NAME,
        version: VERSION,
        input: { q: "btc" },
        idempotencyKey: "key-api-tx-mismatch",
        runtime,
      }),
    ).rejects.toMatchObject({ code: "FACET_CATALOG_MISMATCH" });

    // Tampered pricingOptions[].payTo in catalog must reject with POLICY_RECIPIENT_MISMATCH
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(
            JSON.stringify({
              facet: {
                ...apiFacet,
                pricingOptions: apiFacet.pricingOptions?.map((opt, index) =>
                  index === 1
                    ? {
                        ...opt,
                        payTo: "0x0000000000000000000000000000000000000099",
                      }
                    : opt,
                ),
              },
            }),
            { status: 200 },
          );
        }
        return new Response("unexpected", { status: 500 });
      }),
    );

    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        provider: PROVIDER,
        facetName: FACET_NAME,
        version: VERSION,
        input: { q: "btc" },
        idempotencyKey: "key-api-payto-mismatch",
        runtime,
      }),
    ).rejects.toMatchObject({ code: "POLICY_RECIPIENT_MISMATCH" });

    // Verified API succeeds end-to-end
    const { facet: verifiedApiFacet, runtime: fundedApiRuntime } =
      await setupMultiPricingRuntime({
        facetOverrides: {
          facetType: "API",
          actorMeta: undefined,
          apiMeta: {
            method: "GET",
            pathTemplate: "/v1/items",
            datasetPath: "items",
            registryTxHash: "0x" + "1".repeat(64),
            registryVerified: true,
          },
        },
      });
    const payerAddress = await fundedApiRuntime.walletStore.getWalletAddress();
    const paymentTx = "0x" + "7".repeat(64);
    const receiptTx = "0x" + "8".repeat(64);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet: verifiedApiFacet }), {
            status: 200,
          });
        }
        const sig = (init?.headers as Record<string, string> | undefined)?.[
          "PAYMENT-SIGNATURE"
        ];
        if (!sig) {
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": makeMultiChallengeHeader([
                makeAcceptEntry({
                  pricingModel: "PAY_PER_RUN",
                  unitPriceAtomic: "1000",
                  amount: "1000",
                }),
              ]),
            },
          });
        }
        return new Response(
          JSON.stringify({
            runId: "c66dcf50-5e15-42df-9cf6-a480efd5157f",
            provider: PROVIDER,
            facetName: FACET_NAME,
            facetDisplayName: FACET_DISPLAY_NAME,
            version: VERSION,
            facetType: "API",
            result: { items: [{ ok: true }] },
            dataset: [{ ok: true }],
            usage: {
              itemCount: 1,
              durationMs: 18,
              outputHash: "sha256:" + "d".repeat(64),
              runnerSignature: "0x" + "ef".repeat(65),
            },
            replayed: false,
            payment: {
              transaction: paymentTx,
              network: "eip155:43113",
              pricingModel: "PAY_PER_RUN",
              amountAtomic: "1000",
              payer: payerAddress,
              providerPayTo: PROVIDER_PAY_TO,
            },
            receipt: {
              inputHash: "sha256:" + "e".repeat(64),
              outputHash: "sha256:" + "d".repeat(64),
              itemCount: 1,
              paymentTxHash: paymentTx,
              receiptTxHash: receiptTx,
              runnerSignature: "0x" + "ef".repeat(65),
            },
          }),
          { status: 200 },
        );
      }),
    );

    const settledApi = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { q: "btc" },
      idempotencyKey: "key-api-ok",
      runtime: fundedApiRuntime,
    })) as { status: string; facetType: string };
    expect(settledApi.status).toBe("SETTLED");
    expect(settledApi.facetType).toBe("API");
  });

  it("unconditionally releases SpendLedger (ESCROW_REFUNDED) on 502 refunded both on fresh run and after a 202 pending retry, freeing daily cap", async () => {
    const refundTx = "0x" + "9".repeat(64);
    const paymentTx = "0x" + "2".repeat(64);
    const depositTx = "0x" + "1".repeat(64);
    const receiptTx = "0x" + "3".repeat(64);

    // 1) Fresh run 502 refunded
    const { facet: freshFacet, runtime: freshRuntime } =
      await setupMultiPricingRuntime({
        pricingModelFilter: "PAY_PER_RESULT",
        maxPerRunAtomic: "5000",
        dailyCapAtomic: "5000",
      });
    const freshPayer = await freshRuntime.walletStore.getWalletAddress();
    let freshMode: "refund" | "succeed" = "refund";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet: freshFacet }), {
            status: 200,
          });
        }
        const sig = (init?.headers as Record<string, string> | undefined)?.[
          "PAYMENT-SIGNATURE"
        ];
        if (!sig) {
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": makeMultiChallengeHeader([
                makeAcceptEntry({
                  pricingModel: "PAY_PER_RESULT",
                  unitPriceAtomic: "500",
                  maxItemsCap: 10,
                  amount: "5000",
                }),
              ]),
            },
          });
        }
        if (freshMode === "refund") {
          return new Response(
            JSON.stringify({
              error: { code: "EXECUTION_FAILED", message: "Actor crashed" },
              runId: "d77dcf50-5e15-42df-9cf6-a480efd5157a",
              payment: {
                status: "refunded",
                transaction: refundTx,
                refundAmountAtomic: "5000",
              },
            }),
            { status: 502 },
          );
        }
        return new Response(
          JSON.stringify({
            runId: "d77dcf50-5e15-42df-9cf6-a480efd5157b",
            provider: PROVIDER,
            facetName: FACET_NAME,
            facetDisplayName: FACET_DISPLAY_NAME,
            version: VERSION,
            facetType: "ACTOR",
            result: { items: [{ ok: 1 }] },
            dataset: [{ ok: 1 }],
            usage: {
              itemCount: 1,
              durationMs: 10,
              outputHash: "sha256:" + "d".repeat(64),
              runnerSignature: "0x" + "ef".repeat(65),
            },
            replayed: false,
            payment: {
              transaction: paymentTx,
              network: "eip155:43113",
              pricingModel: "PAY_PER_RESULT",
              amountAtomic: "500",
              unitPriceAtomic: "500",
              maxItemsCap: 10,
              depositedAmountAtomic: "5000",
              refundAmountAtomic: "4500",
              depositTxHash: depositTx,
              payer: freshPayer,
              providerPayTo: PROVIDER_PAY_TO,
            },
            receipt: {
              inputHash: "sha256:" + "e".repeat(64),
              outputHash: "sha256:" + "d".repeat(64),
              itemCount: 1,
              paymentTxHash: paymentTx,
              receiptTxHash: receiptTx,
              runnerSignature: "0x" + "ef".repeat(65),
            },
          }),
          { status: 200 },
        );
      }),
    );

    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        provider: PROVIDER,
        facetName: FACET_NAME,
        version: VERSION,
        input: { fail: true },
        pricingModel: "PAY_PER_RESULT",
        idempotencyKey: "key-fresh-502",
        runtime: freshRuntime,
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_REQUEST_FAILED" });

    const freshEntries = await freshRuntime.spendLedger.list();
    expect(freshEntries).toHaveLength(1);
    expect(freshEntries[0]).toMatchObject({
      status: "RELEASED",
      errorCode: "ESCROW_REFUNDED",
      refundAmountAtomic: "5000",
      paymentTxHash: refundTx,
    });
    expect(
      freshRuntime.retainedPaymentSignatures.has(
        `${PROVIDER}/${FACET_NAME}@${VERSION}:key-fresh-502`,
      ),
    ).toBe(false);

    freshMode = "succeed";
    const freshNext = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { fail: false },
      pricingModel: "PAY_PER_RESULT",
      idempotencyKey: "key-fresh-next",
      runtime: freshRuntime,
    })) as { status: string };
    expect(freshNext.status).toBe("SETTLED");

    // 2) After prior 202 pending retry (hadActiveEntry === true) -> 502 refunded
    const { facet: retryFacet, runtime: retryRuntime } =
      await setupMultiPricingRuntime({
        pricingModelFilter: "PAY_PER_RESULT",
        maxPerRunAtomic: "5000",
        dailyCapAtomic: "5000",
      });
    const retryPayer = await retryRuntime.walletStore.getWalletAddress();
    let retryMode: "202" | "502" | "200" = "202";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet: retryFacet }), {
            status: 200,
          });
        }
        const sig = (init?.headers as Record<string, string> | undefined)?.[
          "PAYMENT-SIGNATURE"
        ];
        if (!sig) {
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": makeMultiChallengeHeader([
                makeAcceptEntry({
                  pricingModel: "PAY_PER_RESULT",
                  unitPriceAtomic: "500",
                  maxItemsCap: 10,
                  amount: "5000",
                }),
              ]),
            },
          });
        }
        if (retryMode === "202") {
          return new Response(
            JSON.stringify({
              runId: "e88dcf50-5e15-42df-9cf6-a480efd5157c",
              provider: PROVIDER,
              facetName: FACET_NAME,
              version: VERSION,
              payment: { status: "escrow_pending", transaction: depositTx },
            }),
            { status: 202 },
          );
        }
        if (retryMode === "502") {
          return new Response(
            JSON.stringify({
              error: { code: "EXECUTION_FAILED", message: "Actor crashed" },
              runId: "e88dcf50-5e15-42df-9cf6-a480efd5157c",
              payment: {
                status: "refunded",
                transaction: refundTx,
                refundAmountAtomic: "5000",
              },
            }),
            { status: 502 },
          );
        }
        return new Response(
          JSON.stringify({
            runId: "e88dcf50-5e15-42df-9cf6-a480efd5157d",
            provider: PROVIDER,
            facetName: FACET_NAME,
            facetDisplayName: FACET_DISPLAY_NAME,
            version: VERSION,
            facetType: "ACTOR",
            result: { items: [{ ok: 2 }] },
            dataset: [{ ok: 2 }],
            usage: {
              itemCount: 1,
              durationMs: 10,
              outputHash: "sha256:" + "d".repeat(64),
              runnerSignature: "0x" + "ef".repeat(65),
            },
            replayed: false,
            payment: {
              transaction: paymentTx,
              network: "eip155:43113",
              pricingModel: "PAY_PER_RESULT",
              amountAtomic: "500",
              unitPriceAtomic: "500",
              maxItemsCap: 10,
              depositedAmountAtomic: "5000",
              refundAmountAtomic: "4500",
              depositTxHash: depositTx,
              payer: retryPayer,
              providerPayTo: PROVIDER_PAY_TO,
            },
            receipt: {
              inputHash: "sha256:" + "e".repeat(64),
              outputHash: "sha256:" + "d".repeat(64),
              itemCount: 1,
              paymentTxHash: paymentTx,
              receiptTxHash: receiptTx,
              runnerSignature: "0x" + "ef".repeat(65),
            },
          }),
          { status: 200 },
        );
      }),
    );

    const pending = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { retry: true },
      pricingModel: "PAY_PER_RESULT",
      idempotencyKey: "key-202-then-502",
      runtime: retryRuntime,
    })) as { status: string };
    expect(pending.status).toBe("PENDING");

    retryMode = "502";
    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        provider: PROVIDER,
        facetName: FACET_NAME,
        version: VERSION,
        input: { retry: true },
        pricingModel: "PAY_PER_RESULT",
        idempotencyKey: "key-202-then-502",
        runtime: retryRuntime,
      }),
    ).rejects.toMatchObject({ code: "GATEWAY_REQUEST_FAILED" });

    const after502Entries = await retryRuntime.spendLedger.list();
    expect(after502Entries).toHaveLength(1);
    expect(after502Entries[0]).toMatchObject({
      status: "RELEASED",
      errorCode: "ESCROW_REFUNDED",
      refundAmountAtomic: "5000",
      paymentTxHash: refundTx,
    });
    expect(
      retryRuntime.retainedPaymentSignatures.has(
        `${PROVIDER}/${FACET_NAME}@${VERSION}:key-202-then-502`,
      ),
    ).toBe(false);

    // Daily cap (5000) is freed so a new run succeeds!
    retryMode = "200";
    const afterRefundNext = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { retry: false },
      pricingModel: "PAY_PER_RESULT",
      idempotencyKey: "key-after-202-502-refund",
      runtime: retryRuntime,
    })) as { status: string };
    expect(afterRefundNext.status).toBe("SETTLED");
  });

  it("rejects pricingModel switches on retained idempotencyKey without replaying the old RetainedPaymentSignature", async () => {
    const { facet, runtime } = await setupMultiPricingRuntime();
    const depositTx = "0x" + "1".repeat(64);
    let calls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet }), { status: 200 });
        }
        calls += 1;
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          pricingModel?: string;
        };
        const sig = (init?.headers as Record<string, string> | undefined)?.[
          "PAYMENT-SIGNATURE"
        ];
        if (body.pricingModel === "PAY_PER_RUN" && !sig) {
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": makeMultiChallengeHeader([
                makeAcceptEntry({
                  pricingModel: "PAY_PER_RUN",
                  unitPriceAtomic: "1000",
                  amount: "1000",
                }),
              ]),
            },
          });
        }
        if (body.pricingModel === "PAY_PER_RUN" && sig) {
          return new Response(
            JSON.stringify({
              runId: "f99dcf50-5e15-42df-9cf6-a480efd5157a",
              provider: PROVIDER,
              facetName: FACET_NAME,
              version: VERSION,
              payment: { status: "settlement_pending", transaction: depositTx },
            }),
            { status: 202 },
          );
        }
        // Different pricingModel with same idempotencyKey hits Gateway and returns 409 IDEMPOTENCY_CONFLICT
        expect(sig).toBeUndefined();
        return new Response(
          JSON.stringify({ error: { code: "IDEMPOTENCY_CONFLICT" } }),
          { status: 409 },
        );
      }),
    );

    const firstPending = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { q: "same" },
      pricingModel: "PAY_PER_RUN",
      idempotencyKey: "key-pricing-switch",
      runtime,
    })) as { status: string };
    expect(firstPending.status).toBe("PENDING");

    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        provider: PROVIDER,
        facetName: FACET_NAME,
        version: VERSION,
        input: { q: "same" },
        pricingModel: "PAY_PER_RESULT",
        idempotencyKey: "key-pricing-switch",
        runtime,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(calls).toBe(3);
  });

  it("passes pricingModel through MCP invoke_facet tool over InMemoryTransport", async () => {
    const { facet, runtime } = await setupMultiPricingRuntime();
    const payerAddress = await runtime.walletStore.getWalletAddress();
    const paymentTx = "0x" + "2".repeat(64);
    const depositTx = "0x" + "1".repeat(64);
    const receiptTx = "0x" + "3".repeat(64);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet }), { status: 200 });
        }
        const parsedBody = JSON.parse(String(init?.body ?? "{}")) as {
          pricingModel?: string;
        };
        expect(parsedBody.pricingModel).toBe("PAY_PER_RESULT");
        const sig = (init?.headers as Record<string, string> | undefined)?.[
          "PAYMENT-SIGNATURE"
        ];
        if (!sig) {
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": makeMultiChallengeHeader([
                makeAcceptEntry({
                  pricingModel: "PAY_PER_RUN",
                  unitPriceAtomic: "1000",
                  amount: "1000",
                }),
                makeAcceptEntry({
                  pricingModel: "PAY_PER_RESULT",
                  unitPriceAtomic: "500",
                  maxItemsCap: 10,
                  amount: "5000",
                }),
              ]),
            },
          });
        }
        return new Response(
          JSON.stringify({
            runId: "a11dcf50-5e15-42df-9cf6-a480efd5157a",
            provider: PROVIDER,
            facetName: FACET_NAME,
            facetDisplayName: FACET_DISPLAY_NAME,
            version: VERSION,
            facetType: "ACTOR",
            result: { items: [{ ok: true }] },
            dataset: [{ ok: true }],
            usage: {
              itemCount: 1,
              durationMs: 12,
              outputHash: "sha256:" + "d".repeat(64),
              runnerSignature: "0x" + "ef".repeat(65),
            },
            replayed: false,
            payment: {
              transaction: paymentTx,
              network: "eip155:43113",
              pricingModel: "PAY_PER_RESULT",
              amountAtomic: "500",
              unitPriceAtomic: "500",
              maxItemsCap: 10,
              depositedAmountAtomic: "5000",
              refundAmountAtomic: "4500",
              depositTxHash: depositTx,
              payer: payerAddress,
              providerPayTo: PROVIDER_PAY_TO,
            },
            receipt: {
              inputHash: "sha256:" + "e".repeat(64),
              outputHash: "sha256:" + "d".repeat(64),
              itemCount: 1,
              paymentTxHash: paymentTx,
              receiptTxHash: receiptTx,
              runnerSignature: "0x" + "ef".repeat(65),
            },
          }),
          { status: 200 },
        );
      }),
    );

    const server = createFacetMcpServer({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      runtime,
    });
    const client = new Client({ name: "mcp-multi-client", version: "0.2.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const invoked = await client.callTool({
        name: "invoke_facet",
        arguments: {
          provider: PROVIDER,
          facetName: FACET_NAME,
          version: VERSION,
          input: { limit: 1 },
          pricingModel: "PAY_PER_RESULT",
          idempotencyKey: "mcp-tool-multi-1",
        },
      });
      expect(invoked.isError).not.toBe(true);
      const text = (invoked.content as Array<{ text: string }>)[0]!.text;
      const body = JSON.parse(text) as {
        status: string;
        payment: {
          pricingModel: string;
          amountAtomic: string;
          depositedAmountAtomic: string;
          refundAmountAtomic: string;
          depositSnowtraceUrl: string;
        };
      };
      expect(body.status).toBe("SETTLED");
      expect(body.payment.pricingModel).toBe("PAY_PER_RESULT");
      expect(body.payment.amountAtomic).toBe("500");
      expect(body.payment.depositedAmountAtomic).toBe("5000");
      expect(body.payment.refundAmountAtomic).toBe("4500");
      expect(body.payment.depositSnowtraceUrl).toBe(
        `https://testnet.snowtrace.io/tx/${depositTx}`,
      );
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });

  it("uses existingEntry.pricingModel option fallbacks on first.ok replay after 202 and cache eviction on a multi-option grant", async () => {
    const { facet, runtime } = await setupMultiPricingRuntime();
    const payerAddress = await runtime.walletStore.getWalletAddress();
    const paymentTx = "0x" + "2".repeat(64);
    const depositTx = "0x" + "1".repeat(64);
    const receiptTx = "0x" + "3".repeat(64);

    let phase: "pending202" | "replay200" = "pending202";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet }), { status: 200 });
        }
        const sig = (init?.headers as Record<string, string> | undefined)?.[
          "PAYMENT-SIGNATURE"
        ];
        if (phase === "pending202") {
          if (!sig) {
            return new Response(JSON.stringify({ error: "payment_required" }), {
              status: 402,
              headers: {
                "PAYMENT-REQUIRED": makeMultiChallengeHeader([
                  makeAcceptEntry({
                    pricingModel: "PAY_PER_RUN",
                    unitPriceAtomic: "1000",
                    amount: "1000",
                  }),
                  makeAcceptEntry({
                    pricingModel: "PAY_PER_RESULT",
                    unitPriceAtomic: "500",
                    maxItemsCap: 10,
                    amount: "5000",
                  }),
                ]),
              },
            });
          }
          return new Response(
            JSON.stringify({
              runId: "b22dcf50-5e15-42df-9cf6-a480efd5157b",
              provider: PROVIDER,
              facetName: FACET_NAME,
              version: VERSION,
              payment: { status: "escrow_pending", transaction: depositTx },
            }),
            { status: 202 },
          );
        }

        // After cache eviction, retry hits Gateway without PAYMENT-SIGNATURE and gets 200 replay
        expect(sig).toBeUndefined();
        return new Response(
          JSON.stringify({
            runId: "b22dcf50-5e15-42df-9cf6-a480efd5157b",
            provider: PROVIDER,
            facetName: FACET_NAME,
            facetDisplayName: FACET_DISPLAY_NAME,
            version: VERSION,
            facetType: "ACTOR",
            result: { items: [{ a: 1 }, { a: 2 }, { a: 3 }], count: 3 },
            dataset: [{ a: 1 }, { a: 2 }, { a: 3 }],
            usage: {
              itemCount: 3,
              durationMs: 15,
              outputHash: "sha256:" + "d".repeat(64),
              runnerSignature: "0x" + "ef".repeat(65),
            },
            replayed: true,
            payment: {
              transaction: paymentTx,
              network: "eip155:43113",
              pricingModel: "PAY_PER_RESULT",
              amountAtomic: "1500",
              payer: payerAddress,
              providerPayTo: PROVIDER_PAY_TO,
            },
            receipt: {
              inputHash: "sha256:" + "e".repeat(64),
              outputHash: "sha256:" + "d".repeat(64),
              itemCount: 3,
              paymentTxHash: paymentTx,
              receiptTxHash: receiptTx,
              runnerSignature: "0x" + "ef".repeat(65),
            },
          }),
          { status: 200 },
        );
      }),
    );

    const pending = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { limit: 3 },
      pricingModel: "PAY_PER_RESULT",
      idempotencyKey: "key-first-ok-fallback",
      runtime,
    })) as { status: string };
    expect(pending.status).toBe("PENDING");

    // Simulate process restart / signature cache eviction and retry without pricingModel
    runtime.retainedPaymentSignatures.clear();
    phase = "replay200";

    const settled = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { limit: 3 },
      idempotencyKey: "key-first-ok-fallback",
      runtime,
    })) as {
      status: string;
      payment: Record<string, unknown>;
    };

    expect(settled.status).toBe("SETTLED");
    expect(settled.payment.pricingModel).toBe("PAY_PER_RESULT");
    expect(settled.payment.unitPriceAtomic).toBe("500");
    expect(settled.payment.maxItemsCap).toBe(10);
    expect(settled.payment.depositedAmountAtomic).toBe("5000");
    expect(settled.payment.refundAmountAtomic).toBe("3500");
    expect(settled.payment.amountAtomic).toBe("1500");

    const entries = await runtime.spendLedger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: "SETTLED",
      pricingModel: "PAY_PER_RESULT",
      amountAtomic: "1500",
      depositedAmountAtomic: "5000",
      refundAmountAtomic: "3500",
      itemCount: 3,
    });
  });

  it("reuses retained PAY_PER_RESULT signature across 202 retry omitting pricingModel on a dual-pricing grant without re-hitting 402", async () => {
    const { facet, runtime } = await setupMultiPricingRuntime();
    const payerAddress = await runtime.walletStore.getWalletAddress();
    const paymentTx = "0x" + "2".repeat(64);
    const depositTx = "0x" + "1".repeat(64);
    const receiptTx = "0x" + "3".repeat(64);
    const signSpy = vi.spyOn(x402Client.prototype, "createPaymentPayload");

    let phase: "202" | "200" = "202";
    let unsignedInvokeCalls = 0;
    const sentSignatures: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet }), { status: 200 });
        }
        const sig = (init?.headers as Record<string, string> | undefined)?.[
          "PAYMENT-SIGNATURE"
        ];
        if (!sig) {
          unsignedInvokeCalls += 1;
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": makeMultiChallengeHeader([
                makeAcceptEntry({
                  pricingModel: "PAY_PER_RUN",
                  unitPriceAtomic: "1000",
                  amount: "1000",
                }),
                makeAcceptEntry({
                  pricingModel: "PAY_PER_RESULT",
                  unitPriceAtomic: "500",
                  maxItemsCap: 10,
                  amount: "5000",
                }),
              ]),
            },
          });
        }
        sentSignatures.push(sig);
        if (phase === "202") {
          return new Response(
            JSON.stringify({
              runId: "c11dcf50-5e15-42df-9cf6-a480efd5157a",
              provider: PROVIDER,
              facetName: FACET_NAME,
              version: VERSION,
              payment: { status: "escrow_pending", transaction: depositTx },
            }),
            { status: 202 },
          );
        }
        return new Response(
          JSON.stringify({
            runId: "c11dcf50-5e15-42df-9cf6-a480efd5157a",
            provider: PROVIDER,
            facetName: FACET_NAME,
            facetDisplayName: FACET_DISPLAY_NAME,
            version: VERSION,
            facetType: "ACTOR",
            result: { items: [{ a: 1 }, { a: 2 }, { a: 3 }], count: 3 },
            dataset: [{ a: 1 }, { a: 2 }, { a: 3 }],
            usage: {
              itemCount: 3,
              durationMs: 20,
              outputHash: "sha256:" + "d".repeat(64),
              runnerSignature: "0x" + "ef".repeat(65),
            },
            replayed: true,
            payment: {
              transaction: paymentTx,
              network: "eip155:43113",
              pricingModel: "PAY_PER_RESULT",
              amountAtomic: "1500",
              unitPriceAtomic: "500",
              maxItemsCap: 10,
              depositedAmountAtomic: "5000",
              refundAmountAtomic: "3500",
              depositTxHash: depositTx,
              payer: payerAddress,
              providerPayTo: PROVIDER_PAY_TO,
            },
            receipt: {
              inputHash: "sha256:" + "e".repeat(64),
              outputHash: "sha256:" + "d".repeat(64),
              itemCount: 3,
              paymentTxHash: paymentTx,
              receiptTxHash: receiptTx,
              runnerSignature: "0x" + "ef".repeat(65),
            },
          }),
          { status: 200 },
        );
      }),
    );

    const pending = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { limit: 3 },
      pricingModel: "PAY_PER_RESULT",
      idempotencyKey: "key-202-omit-retry",
      runtime,
    })) as { status: string };
    expect(pending.status).toBe("PENDING");
    expect(unsignedInvokeCalls).toBe(1);
    expect(signSpy).toHaveBeenCalledTimes(1);

    // Retry omitting pricingModel (per formatPendingInvokeResult instructions)
    phase = "200";
    const settled = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { limit: 3 },
      idempotencyKey: "key-202-omit-retry",
      runtime,
    })) as { status: string; payment: Record<string, unknown> };

    expect(settled.status).toBe("SETTLED");
    expect(settled.payment.pricingModel).toBe("PAY_PER_RESULT");
    expect(settled.payment.amountAtomic).toBe("1500");
    expect(unsignedInvokeCalls).toBe(1);
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(sentSignatures).toHaveLength(2);
    expect(sentSignatures[1]).toBe(sentSignatures[0]);
  });

  it("reuses retained signature across 202 retry when initial call omitted pricingModel and retry specifies resolved PAY_PER_RESULT", async () => {
    const optionsWithResultPrimary: FacetPricingOption[] = [
      {
        model: "PAY_PER_RUN",
        priceAtomic: "1000",
        maxAmountAtomic: "1000",
        assetAddress: FUSD_ASSET_ADDRESS,
        chainId: FUJI_CHAIN_ID,
        payTo: PROVIDER_PAY_TO,
        isPrimary: false,
      },
      {
        model: "PAY_PER_RESULT",
        priceAtomic: "500",
        maxItemsCap: 10,
        maxAmountAtomic: "5000",
        assetAddress: FUSD_ASSET_ADDRESS,
        chainId: FUJI_CHAIN_ID,
        payTo: PROVIDER_PAY_TO,
        isPrimary: true,
      },
    ];
    const { facet, runtime } = await setupMultiPricingRuntime({
      facetOverrides: {
        pricing: optionsWithResultPrimary[1],
        pricingOptions: optionsWithResultPrimary,
      },
    });
    const payerAddress = await runtime.walletStore.getWalletAddress();
    const paymentTx = "0x" + "2".repeat(64);
    const depositTx = "0x" + "1".repeat(64);
    const receiptTx = "0x" + "3".repeat(64);
    const signSpy = vi.spyOn(x402Client.prototype, "createPaymentPayload");

    let phase: "202" | "200" = "202";
    let unsignedInvokeCalls = 0;
    const sentSignatures: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet }), { status: 200 });
        }
        const sig = (init?.headers as Record<string, string> | undefined)?.[
          "PAYMENT-SIGNATURE"
        ];
        if (!sig) {
          unsignedInvokeCalls += 1;
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": makeMultiChallengeHeader([
                makeAcceptEntry({
                  pricingModel: "PAY_PER_RUN",
                  unitPriceAtomic: "1000",
                  amount: "1000",
                }),
                makeAcceptEntry({
                  pricingModel: "PAY_PER_RESULT",
                  unitPriceAtomic: "500",
                  maxItemsCap: 10,
                  amount: "5000",
                }),
              ]),
            },
          });
        }
        sentSignatures.push(sig);
        if (phase === "202") {
          return new Response(
            JSON.stringify({
              runId: "c22dcf50-5e15-42df-9cf6-a480efd5157a",
              provider: PROVIDER,
              facetName: FACET_NAME,
              version: VERSION,
              payment: { status: "escrow_pending", transaction: depositTx },
            }),
            { status: 202 },
          );
        }
        return new Response(
          JSON.stringify({
            runId: "c22dcf50-5e15-42df-9cf6-a480efd5157a",
            provider: PROVIDER,
            facetName: FACET_NAME,
            facetDisplayName: FACET_DISPLAY_NAME,
            version: VERSION,
            facetType: "ACTOR",
            result: { items: [{ a: 1 }], count: 1 },
            dataset: [{ a: 1 }],
            usage: {
              itemCount: 1,
              durationMs: 12,
              outputHash: "sha256:" + "d".repeat(64),
              runnerSignature: "0x" + "ef".repeat(65),
            },
            replayed: true,
            payment: {
              transaction: paymentTx,
              network: "eip155:43113",
              pricingModel: "PAY_PER_RESULT",
              amountAtomic: "500",
              unitPriceAtomic: "500",
              maxItemsCap: 10,
              depositedAmountAtomic: "5000",
              refundAmountAtomic: "4500",
              depositTxHash: depositTx,
              payer: payerAddress,
              providerPayTo: PROVIDER_PAY_TO,
            },
            receipt: {
              inputHash: "sha256:" + "e".repeat(64),
              outputHash: "sha256:" + "d".repeat(64),
              itemCount: 1,
              paymentTxHash: paymentTx,
              receiptTxHash: receiptTx,
              runnerSignature: "0x" + "ef".repeat(65),
            },
          }),
          { status: 200 },
        );
      }),
    );

    const pending = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { limit: 1 },
      idempotencyKey: "key-202-explicit-retry",
      runtime,
    })) as { status: string };
    expect(pending.status).toBe("PENDING");
    expect(unsignedInvokeCalls).toBe(1);
    expect(signSpy).toHaveBeenCalledTimes(1);

    // Retry explicitly specifying resolved PAY_PER_RESULT
    phase = "200";
    const settled = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { limit: 1 },
      pricingModel: "PAY_PER_RESULT",
      idempotencyKey: "key-202-explicit-retry",
      runtime,
    })) as { status: string; payment: Record<string, unknown> };

    expect(settled.status).toBe("SETTLED");
    expect(settled.payment.pricingModel).toBe("PAY_PER_RESULT");
    expect(settled.payment.amountAtomic).toBe("500");
    expect(unsignedInvokeCalls).toBe(1);
    expect(signSpy).toHaveBeenCalledTimes(1);
    expect(sentSignatures).toHaveLength(2);
    expect(sentSignatures[1]).toBe(sentSignatures[0]);
  });

  it("preserves existingEntry.pricingModel in 402 challenge selection on cold-cache retry omitting pricingModel", async () => {
    const { facet, runtime } = await setupMultiPricingRuntime();
    const payerAddress = await runtime.walletStore.getWalletAddress();
    const paymentTx = "0x" + "2".repeat(64);
    const depositTx = "0x" + "1".repeat(64);
    const receiptTx = "0x" + "3".repeat(64);
    const signSpy = vi.spyOn(x402Client.prototype, "createPaymentPayload");

    let phase: "202" | "cold402" = "202";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        if (String(url).includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet }), { status: 200 });
        }
        const sig = (init?.headers as Record<string, string> | undefined)?.[
          "PAYMENT-SIGNATURE"
        ];
        if (!sig) {
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": makeMultiChallengeHeader([
                makeAcceptEntry({
                  pricingModel: "PAY_PER_RUN",
                  unitPriceAtomic: "1000",
                  amount: "1000",
                }),
                makeAcceptEntry({
                  pricingModel: "PAY_PER_RESULT",
                  unitPriceAtomic: "500",
                  maxItemsCap: 10,
                  amount: "5000",
                }),
              ]),
            },
          });
        }
        if (phase === "202") {
          return new Response(
            JSON.stringify({
              runId: "c33dcf50-5e15-42df-9cf6-a480efd5157a",
              provider: PROVIDER,
              facetName: FACET_NAME,
              version: VERSION,
              payment: { status: "escrow_pending", transaction: depositTx },
            }),
            { status: 202 },
          );
        }
        return new Response(
          JSON.stringify({
            runId: "c33dcf50-5e15-42df-9cf6-a480efd5157a",
            provider: PROVIDER,
            facetName: FACET_NAME,
            facetDisplayName: FACET_DISPLAY_NAME,
            version: VERSION,
            facetType: "ACTOR",
            result: { items: [{ a: 1 }, { a: 2 }], count: 2 },
            dataset: [{ a: 1 }, { a: 2 }],
            usage: {
              itemCount: 2,
              durationMs: 14,
              outputHash: "sha256:" + "d".repeat(64),
              runnerSignature: "0x" + "ef".repeat(65),
            },
            replayed: false,
            payment: {
              transaction: paymentTx,
              network: "eip155:43113",
              pricingModel: "PAY_PER_RESULT",
              amountAtomic: "1000",
              unitPriceAtomic: "500",
              maxItemsCap: 10,
              depositedAmountAtomic: "5000",
              refundAmountAtomic: "4000",
              depositTxHash: depositTx,
              payer: payerAddress,
              providerPayTo: PROVIDER_PAY_TO,
            },
            receipt: {
              inputHash: "sha256:" + "e".repeat(64),
              outputHash: "sha256:" + "d".repeat(64),
              itemCount: 2,
              paymentTxHash: paymentTx,
              receiptTxHash: receiptTx,
              runnerSignature: "0x" + "ef".repeat(65),
            },
          }),
          { status: 200 },
        );
      }),
    );

    const pending = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { limit: 2 },
      pricingModel: "PAY_PER_RESULT",
      idempotencyKey: "key-cold-402-preserve",
      runtime,
    })) as { status: string };
    expect(pending.status).toBe("PENDING");

    // Evict retained signature cache (simulating restart) and hit 402 again without pricingModel
    runtime.retainedPaymentSignatures.clear();
    phase = "cold402";

    const settled = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { limit: 2 },
      idempotencyKey: "key-cold-402-preserve",
      runtime,
    })) as { status: string; payment: Record<string, unknown> };

    expect(settled.status).toBe("SETTLED");
    expect(settled.payment.pricingModel).toBe("PAY_PER_RESULT");
    expect(settled.payment.amountAtomic).toBe("1000");
    expect(signSpy).toHaveBeenCalledTimes(2);
    const secondSignedRequired = signSpy.mock.calls[1]![0] as {
      accepts: Array<{ extra?: Record<string, unknown> }>;
    };
    expect(secondSignedRequired.accepts).toHaveLength(1);
    expect(secondSignedRequired.accepts[0]?.extra?.pricingModel).toBe(
      "PAY_PER_RESULT",
    );
  });

  it("signs EIP-712 ReceiveWithAuthorization when challenge extra specifies it and surfaces escrowExpiresAt in 202 pending", async () => {
    const { facet, runtime } = await setupMultiPricingRuntime();
    const payerAddress = await runtime.walletStore.getWalletAddress();
    const sentHeaders: string[] = [];
    const expiresAt = "2027-01-15T08:15:00.000Z";
    const runId = "019a1234-5678-7abc-8def-123456789abc";

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/v1/catalog/facets/")) {
          return new Response(JSON.stringify({ facet }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        const headers = new Headers(init?.headers);
        const paymentSig = headers.get("PAYMENT-SIGNATURE");
        if (!paymentSig) {
          const header = encodePaymentRequiredHeader({
            x402Version: 2,
            resource: {
              url: `${PUBLIC_ORIGIN}/v1/facets/${PROVIDER}/${FACET_NAME}/versions/${VERSION}/invoke`,
              description: "Echo Actor",
              mimeType: "application/json",
            },
            accepts: [
              {
                scheme: "exact",
                network: "eip155:43113",
                asset: FUSD_ASSET_ADDRESS,
                amount: "5000",
                payTo: FACET_FEE_SPLIT_ADDRESS,
                maxTimeoutSeconds: 60,
                extra: {
                  name: "FACET USD",
                  version: "2",
                  authorizationType: "ReceiveWithAuthorization",
                  pricingModel: "PAY_PER_RESULT",
                  unitPriceAtomic: "500",
                  maxItemsCap: 10,
                  providerPayTo: PROVIDER_PAY_TO,
                },
              },
            ],
          });
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: { "PAYMENT-REQUIRED": header },
          });
        }
        sentHeaders.push(paymentSig);
        return new Response(
          JSON.stringify({
            runId,
            payment: {
              status: "escrow_pending",
              transaction: `0x${"a".repeat(64)}`,
              escrowExpiresAt: expiresAt,
            },
          }),
          { status: 202, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const pending = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      provider: PROVIDER,
      facetName: FACET_NAME,
      version: VERSION,
      input: { text: "hello" },
      pricingModel: "PAY_PER_RESULT",
      idempotencyKey: "key-receive-auth",
      runtime,
    })) as {
      status: string;
      runId?: string;
      escrowExpiresAt?: string;
      note?: string;
      payment: Record<string, unknown>;
    };

    expect(pending.status).toBe("PENDING");
    expect(pending.runId).toBe(runId);
    expect(pending.escrowExpiresAt).toBe(expiresAt);
    expect(pending.payment.escrowExpiresAt).toBe(expiresAt);
    expect(pending.note).toContain(`facet escrow reclaim ${runId}`);

    expect(sentHeaders).toHaveLength(1);
    const decoded = decodePaymentSignatureHeader(sentHeaders[0]!);
    const rawPayload = decoded.payload as {
      authorization: {
        from: string;
        to: string;
        value: string;
        validAfter: string;
        validBefore: string;
        nonce: Hex;
      };
      signature: Hex;
    };

    const validReceiveSig = await verifyTypedData({
      address: getAddress(payerAddress),
      domain: {
        name: "FACET USD",
        version: "2",
        chainId: FUJI_CHAIN_ID,
        verifyingContract: getAddress(FUSD_ASSET_ADDRESS),
      },
      types: {
        ReceiveWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "ReceiveWithAuthorization",
      message: {
        from: getAddress(rawPayload.authorization.from),
        to: getAddress(rawPayload.authorization.to),
        value: BigInt(rawPayload.authorization.value),
        validAfter: BigInt(rawPayload.authorization.validAfter),
        validBefore: BigInt(rawPayload.authorization.validBefore),
        nonce: rawPayload.authorization.nonce,
      },
      signature: rawPayload.signature,
    });
    expect(validReceiveSig).toBe(true);
  });
});
