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
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { x402Client } from "@x402/core/client";
import { encodePaymentRequiredHeader } from "@x402/core/http";
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
    } finally {
      await Promise.all([client.close(), server.close()]);
    }
  });
});
