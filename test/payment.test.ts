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
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalBuyerRuntime } from "../src/local-wallet.js";
import {
  invokeWithPayment,
  validateChallengeForGrant,
} from "../src/payment.js";

const tempDirs: string[] = [];
const TEST_PRIVATE_KEY = ("0x" + "7".repeat(64)) as `0x${string}`;
const CREATOR_PAY_TO = "0x9265c1c87fC5fb3C72Dc68b4D3A005dE1E22C3cf" as const;
const FACET_ID = "01a1e97a-90e0-7030-b565-91c9abc3857b";
const VERSION_ID = "01a1e97a-90e0-7038-b9ff-4f8d2a599e04";
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
    id: FACET_ID,
    versionId: VERSION_ID,
    slug: "echo-actor",
    fullName: "taihung/echo-actor",
    name: "Echo Actor",
    displayVersion: "v1",
    facetType: "HOSTED_ACTOR",
    pricing: {
      model: "PAY_PER_RUN",
      priceAtomic: "1000",
      assetAddress: FUSD_ASSET_ADDRESS,
      chainId: FUJI_CHAIN_ID,
      payTo: CREATOR_PAY_TO,
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
  creatorPayTo?: string;
}) {
  const required = {
    x402Version: 2,
    resource: {
      url:
        overrides?.resourceUrl ??
        `${PUBLIC_ORIGIN}/v1/facet-versions/${VERSION_ID}/invoke?fingerprint=abc`,
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
          ...(overrides?.creatorPayTo
            ? { creatorPayTo: overrides.creatorPayTo }
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
    facetId: FACET_ID,
    versionId: VERSION_ID,
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
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("MCP local-wallet x402 payment guard", () => {
  it("completes 402 -> 200 with Snowtrace links, confirms ledger, and omits raw keys/signatures", async () => {
    const { facet, runtime } = await setupRuntime();
    const payerAddress = await runtime.walletStore.getWalletAddress();
    const paymentTx = "0x" + "2".repeat(64);
    const receiptTx = "0x" + "3".repeat(64);

    let invokeAttempt = 0;
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const href = String(url);
      if (href === `${PUBLIC_ORIGIN}/v1/catalog/facets/${FACET_ID}`) {
        return new Response(JSON.stringify({ facet }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (href === `${PUBLIC_ORIGIN}/v1/facet-versions/${VERSION_ID}/invoke`) {
        invokeAttempt += 1;
        if (invokeAttempt === 1) {
          return new Response(JSON.stringify({ error: "payment_required" }), {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": makeChallengeHeader({
                creatorPayTo: CREATOR_PAY_TO,
              }),
            },
          });
        }
        const headers = init?.headers as Record<string, string>;
        expect(headers["PAYMENT-SIGNATURE"]).toBeTruthy();
        return new Response(
          JSON.stringify({
            runId: "b55dcf50-5e15-42df-9cf6-a480efd5157d",
            facetVersionId: VERSION_ID,
            facetFullName: "taihung/echo-actor",
            displayVersion: "v1",
            facetType: "HOSTED_ACTOR",
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
              creatorPayTo: CREATOR_PAY_TO,
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
      facetVersionId: VERSION_ID,
      input: { text: "hi" },
      idempotencyKey: "key-1",
      runtime,
    })) as Record<string, unknown>;

    expect(out.runId).toBe("b55dcf50-5e15-42df-9cf6-a480efd5157d");
    const payment = out.payment as Record<string, unknown>;
    const receipt = out.receipt as Record<string, unknown>;
    expect(payment.amountAtomic).toBe("1000");
    expect(payment.payer).toBe(payerAddress);
    expect(payment.creatorPayTo).toBe(CREATOR_PAY_TO);
    expect(payment.snowtraceUrl).toBe(
      `https://testnet.snowtrace.io/tx/${paymentTx}`,
    );
    expect(receipt.receiptTxHash).toBe(receiptTx);
    expect(receipt.snowtraceUrl).toBe(
      `https://testnet.snowtrace.io/tx/${receiptTx}`,
    );
    expect(JSON.stringify(out)).not.toContain(TEST_PRIVATE_KEY.slice(2));
    expect(JSON.stringify(out)).not.toContain("PAYMENT-SIGNATURE");

    const entries = await runtime.spendLedger.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe("SETTLED");
  });

  it("denies wrong chain, asset, fee-split payTo, creator, version, and amount before signing", async () => {
    const { runtime } = await setupRuntime();
    const grant = (await runtime.policyStore.findGrant(FACET_ID, VERSION_ID))!;

    function expectErrorCode(fn: () => unknown, code: string) {
      let caught: unknown;
      try {
        fn();
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({ code });
    }

    expectErrorCode(
      () =>
        validateChallengeForGrant(
          makeChallengeHeader({ network: "eip155:43114" }),
          grant,
          VERSION_ID,
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
          VERSION_ID,
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
          VERSION_ID,
        ),
      "POLICY_RECIPIENT_MISMATCH",
    );

    expectErrorCode(
      () =>
        validateChallengeForGrant(
          makeChallengeHeader({
            creatorPayTo: "0x0000000000000000000000000000000000000099",
          }),
          grant,
          VERSION_ID,
        ),
      "POLICY_RECIPIENT_MISMATCH",
    );

    expectErrorCode(
      () =>
        validateChallengeForGrant(
          makeChallengeHeader({
            resourceUrl: `${PUBLIC_ORIGIN}/v1/facet-versions/00000000-0000-4000-8000-000000000099/invoke`,
          }),
          grant,
          VERSION_ID,
        ),
      "PAYMENT_CHALLENGE_NOT_ALLOWED",
    );

    expectErrorCode(
      () =>
        validateChallengeForGrant(
          makeChallengeHeader({ amount: "1500" }),
          grant,
          VERSION_ID,
        ),
      "POLICY_MAX_PER_RUN_EXCEEDED",
    );

    // Ungranted version denied (default-deny)
    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        facetVersionId: "00000000-0000-4000-8000-000000000099",
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
        facetVersionId: VERSION_ID,
        input: { text: "hi" },
        idempotencyKey: "key-low-bal",
        runtime,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_FUSD_BALANCE" });

    expect(await runtime.spendLedger.list()).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps reservation PENDING without false receipt on 202 and timeout, releases on 409 conflict, and replays without second charge", async () => {
    const { facet, runtime } = await setupRuntime({ dailyCapAtomic: "1000" });
    const paymentTx = "0x" + "5".repeat(64);
    const receiptTx = "0x" + "6".repeat(64);

    // 1) 202 pending keeps reservation PENDING and returns no receipt Snowtrace URL
    let mode: "202" | "timeout" | "409" | "200" = "202";
    const fetchMock = vi.fn(async (url: URL | string, init?: RequestInit) => {
      const href = String(url);
      if (href.includes("/v1/catalog/facets/")) {
        return new Response(JSON.stringify({ facet }), { status: 200 });
      }
      const hasSig = Boolean(
        (init?.headers as Record<string, string> | undefined)?.[
          "PAYMENT-SIGNATURE"
        ],
      );
      if (!hasSig) {
        return new Response(JSON.stringify({ error: "payment_required" }), {
          status: 402,
          headers: { "PAYMENT-REQUIRED": makeChallengeHeader() },
        });
      }
      if (mode === "202") {
        return new Response(
          JSON.stringify({
            runId: "b55dcf50-5e15-42df-9cf6-a480efd5157d",
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
          facetVersionId: VERSION_ID,
          result: { ok: true },
          dataset: [{ ok: true }],
          replayed: true,
          payment: {
            transaction: paymentTx,
            network: "eip155:43113",
            amountAtomic: "1000",
            payer: await runtime.walletStore.getWalletAddress(),
            creatorPayTo: CREATOR_PAY_TO,
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

    const pending202 = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      facetVersionId: VERSION_ID,
      input: { text: "hi" },
      idempotencyKey: "key-pending",
      runtime,
    })) as Record<string, unknown>;
    expect(pending202.status).toBe("PENDING");
    expect(pending202.receipt).toBeUndefined();
    expect((await runtime.spendLedger.list())[0]?.status).toBe("PENDING");

    // Different key hits daily cap while key-pending is still PENDING
    await expect(
      invokeWithPayment({
        controlUrl: PUBLIC_ORIGIN,
        gatewayUrl: PUBLIC_ORIGIN,
        facetVersionId: VERSION_ID,
        input: { text: "other" },
        idempotencyKey: "key-second",
        runtime,
      }),
    ).rejects.toMatchObject({ code: "DAILY_CAP_EXCEEDED" });

    // Timeout on retry with same key keeps PENDING
    mode = "timeout";
    const pendingTimeout = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      facetVersionId: VERSION_ID,
      input: { text: "hi" },
      idempotencyKey: "key-pending",
      runtime,
    })) as Record<string, unknown>;
    expect(pendingTimeout.status).toBe("PENDING");
    expect((await runtime.spendLedger.list())[0]?.status).toBe("PENDING");

    // Same-key retry succeeds (200) without a second ledger reservation
    mode = "200";
    const settled = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      facetVersionId: VERSION_ID,
      input: { text: "hi" },
      idempotencyKey: "key-pending",
      runtime,
    })) as Record<string, unknown>;
    expect(settled.replayed).toBe(true);
    expect(await runtime.spendLedger.list()).toHaveLength(1);
    expect((await runtime.spendLedger.list())[0]?.status).toBe("SETTLED");

    // Replay again after SETTLED still succeeds with 1 ledger entry
    const settledReplay = (await invokeWithPayment({
      controlUrl: PUBLIC_ORIGIN,
      gatewayUrl: PUBLIC_ORIGIN,
      facetVersionId: VERSION_ID,
      input: { text: "hi" },
      idempotencyKey: "key-pending",
      runtime,
    })) as Record<string, unknown>;
    expect(settledReplay.replayed).toBe(true);
    expect(await runtime.spendLedger.list()).toHaveLength(1);

    // 409 conflict on a new key (after releasing cap for test) releases reservation cleanly
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
        facetVersionId: VERSION_ID,
        input: { text: "changed" },
        idempotencyKey: "key-conflict",
        runtime: conflictRuntime,
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect((await conflictRuntime.spendLedger.list())[0]?.status).toBe(
      "RELEASED",
    );
  });
});
