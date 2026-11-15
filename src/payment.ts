import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const fujiAsset = "0xe7082a54a456dc4dfe0ceadcd0d0dce7d8ba176f";

export function checkChallenge(
  header: string,
  recipient: string,
  maxAtomic: bigint,
  gatewayUrl: string,
) {
  const required = decodePaymentRequiredHeader(header);
  const option = required.accepts[0];
  if (
    required.x402Version !== 2 ||
    required.accepts.length !== 1 ||
    !option ||
    option.scheme !== "exact" ||
    option.network !== "eip155:43113" ||
    option.asset.toLowerCase() !== fujiAsset.toLowerCase() ||
    option.payTo.toLowerCase() !== recipient.toLowerCase() ||
    !/^[1-9][0-9]*$/u.test(option.amount) ||
    BigInt(option.amount) > maxAtomic ||
    option.extra?.name !== "FACET USD" ||
    option.extra?.version !== "2" ||
    !required.resource.url.startsWith(
      new URL("/v1/facet-versions/", gatewayUrl).href,
    )
  )
    throw new Error("PAYMENT_CHALLENGE_NOT_ALLOWED");
  return required;
}

export async function invokeWithPayment(
  gatewayUrl: string,
  facetVersionId: string,
  input: Record<string, unknown>,
  idempotencyKey: string,
): Promise<unknown> {
  const url = new URL(
    `/v1/facet-versions/${facetVersionId}/invoke`,
    gatewayUrl,
  );
  const headers = {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
  const body = JSON.stringify({ input });
  const first = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(45_000),
  });
  if (first.status !== 402) {
    const result: unknown = await first.json();
    if (!first.ok && first.status !== 202)
      throw new Error(
        `Gateway returned ${first.status}: ${JSON.stringify(result)}`,
      );
    return result;
  }
  const key = process.env.FACET_DEMO_PAYER_PRIVATE_KEY;
  const recipient = process.env.FACET_DEMO_PAY_TO;
  const max = process.env.FACET_DEMO_MAX_PAYMENT_ATOMIC;
  if (
    !key ||
    !/^0x[a-f0-9]{64}$/iu.test(key) ||
    !recipient ||
    !/^0x[a-f0-9]{40}$/iu.test(recipient) ||
    !max ||
    !/^[1-9][0-9]*$/u.test(max)
  )
    throw new Error("LOCAL_TESTNET_PAYER_NOT_CONFIGURED");
  const challenge = first.headers.get("PAYMENT-REQUIRED");
  if (!challenge) throw new Error("PAYMENT_CHALLENGE_MISSING");
  const required = checkChallenge(
    challenge,
    recipient,
    BigInt(max),
    gatewayUrl,
  );
  const client = x402Client.fromConfig({
    schemes: [
      {
        network: "eip155:43113",
        client: new ExactEvmScheme(privateKeyToAccount(key as `0x${string}`)),
      },
    ],
    spendControls: {
      allowedAssets: [
        { network: "eip155:43113", asset: fujiAsset, maxAmountPerPayment: max },
      ],
    },
  });
  const payload = await client.createPaymentPayload(required);
  const paid = await fetch(url, {
    method: "POST",
    headers: {
      ...headers,
      "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload),
    },
    body,
    signal: AbortSignal.timeout(45_000),
  });
  const result: unknown = await paid.json();
  if (!paid.ok && paid.status !== 202)
    throw new Error(
      `Gateway returned ${paid.status}: ${JSON.stringify(result)}`,
    );
  return result;
}
