import {
  FacetClient,
  SpendLedgerError,
  SpendPolicyError,
  readFujiWalletStatus,
  redactSecrets,
  validateGrantAgainstChallenge,
  type PublicFacetRecord,
  type SpendPolicyGrant,
} from "@facet-aex/cli";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  formatPendingInvokeResult,
  formatSettledInvokeResult,
  type GatewayPaidResponse,
  type LocalBuyerRuntime,
} from "./local-wallet.js";

export type McpPaymentErrorCode =
  | "PAYMENT_CHALLENGE_MISSING"
  | "PAYMENT_CHALLENGE_NOT_ALLOWED"
  | "INSUFFICIENT_FUSD_BALANCE"
  | "FACET_CATALOG_MISMATCH"
  | "IDEMPOTENCY_CONFLICT"
  | "GATEWAY_REQUEST_FAILED"
  | "PAYMENT_RECEIPT_MISSING";

export class McpPaymentError extends Error {
  constructor(
    public readonly code: McpPaymentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpPaymentError";
  }
}

export function validateChallengeForGrant(
  header: string,
  grant: SpendPolicyGrant,
  expectedVersionId: string,
) {
  const required = decodePaymentRequiredHeader(header);
  const option = required.accepts[0];
  if (
    required.x402Version !== 2 ||
    required.accepts.length !== 1 ||
    !option ||
    option.scheme !== "exact" ||
    option.extra?.name !== "FACET USD" ||
    option.extra?.version !== "2"
  ) {
    throw new McpPaymentError(
      "PAYMENT_CHALLENGE_NOT_ALLOWED",
      "Gateway returned an unsupported x402 v2 payment challenge.",
    );
  }

  let resourcePath: string;
  try {
    resourcePath = new URL(required.resource.url).pathname;
  } catch {
    throw new McpPaymentError(
      "PAYMENT_CHALLENGE_NOT_ALLOWED",
      "Payment challenge resource.url is not a valid URL.",
    );
  }

  if (resourcePath !== `/v1/facet-versions/${expectedVersionId}/invoke`) {
    throw new McpPaymentError(
      "PAYMENT_CHALLENGE_NOT_ALLOWED",
      `Payment challenge resource path ${resourcePath} does not match expected version ${expectedVersionId}.`,
    );
  }

  const networkParts = option.network.split(":");
  const chainId =
    networkParts[0] === "eip155" && /^[0-9]+$/u.test(networkParts[1] ?? "")
      ? Number(networkParts[1])
      : -1;
  const challengeCreator =
    typeof option.extra?.creatorPayTo === "string"
      ? option.extra.creatorPayTo
      : undefined;

  validateGrantAgainstChallenge(grant, {
    facetId: grant.facetId,
    facetVersionId: expectedVersionId,
    chainId,
    assetAddress: option.asset,
    settlementPayTo: option.payTo,
    ...(challengeCreator ? { creatorPayTo: challengeCreator } : {}),
    amountAtomic: option.amount,
  });

  return required;
}

async function verifyCatalogPin(
  controlUrl: string,
  grant: SpendPolicyGrant,
): Promise<PublicFacetRecord> {
  const client = new FacetClient({ controlApiUrl: controlUrl });
  const facet = (await client.getFacet(grant.facetId)) as
    PublicFacetRecord | undefined;
  if (!facet) {
    throw new McpPaymentError(
      "FACET_CATALOG_MISMATCH",
      `Catalog facet ${grant.facetId} is no longer available.`,
    );
  }
  if (facet.versionId !== grant.versionId) {
    throw new McpPaymentError(
      "FACET_CATALOG_MISMATCH",
      `Catalog version ${facet.versionId} does not match granted immutable version ${grant.versionId}.`,
    );
  }
  if (!facet.pricing) {
    throw new McpPaymentError(
      "FACET_CATALOG_MISMATCH",
      "Catalog Facet is missing pricing metadata.",
    );
  }
  if (facet.pricing.payTo.toLowerCase() !== grant.creatorPayTo.toLowerCase()) {
    throw new SpendPolicyError(
      "POLICY_RECIPIENT_MISMATCH",
      `Catalog creator payTo ${facet.pricing.payTo} does not match pinned grant ${grant.creatorPayTo}.`,
    );
  }
  const verified =
    facet.facetType === "HOSTED_ACTOR"
      ? facet.actorMeta?.registryVerified === true
      : facet.facetType === "AUTONOMOUS_AGENT"
        ? facet.agentMeta?.registryVerified === true
        : false;
  if (!verified) {
    throw new SpendPolicyError(
      "UNVERIFIED_FACET_REGISTRY",
      "Catalog Facet is not marked registryVerified on Fuji.",
    );
  }
  return facet;
}

export interface InvokeWithPaymentOptions {
  controlUrl: string;
  gatewayUrl: string;
  facetVersionId: string;
  input: Record<string, unknown>;
  idempotencyKey: string;
  runtime: LocalBuyerRuntime;
}

export async function invokeWithPayment(
  options: InvokeWithPaymentOptions,
): Promise<unknown> {
  const {
    controlUrl,
    gatewayUrl,
    facetVersionId,
    input,
    idempotencyKey,
    runtime,
  } = options;

  const grant = await runtime.policyStore.findGrantByVersion(facetVersionId);
  if (!grant) {
    throw new SpendPolicyError(
      "POLICY_NOT_GRANTED",
      `Default-deny: no spending policy granted for facetVersionId ${facetVersionId}. Run \`facet policy grant --facet ...\` first.`,
    );
  }

  // Re-validate non-expired & non-revoked policy and confirm live catalog pin before any call.
  validateGrantAgainstChallenge(grant, {
    facetId: grant.facetId,
    facetVersionId,
    chainId: grant.chainId,
    assetAddress: grant.assetAddress,
    settlementPayTo: grant.settlementContract,
    creatorPayTo: grant.creatorPayTo,
    amountAtomic: grant.pinnedPriceAtomic,
  });
  await verifyCatalogPin(controlUrl, grant);

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

  const payerAddress = await runtime.walletStore.getWalletAddress();

  if (first.status !== 402) {
    const result = (await first.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (first.status === 202) {
      const paymentObj = result.payment as
        { status?: string; transaction?: string } | undefined;
      return formatPendingInvokeResult({
        ...(typeof result.runId === "string" ? { runId: result.runId } : {}),
        facetVersionId,
        idempotencyKey,
        amountAtomic: grant.pinnedPriceAtomic,
        paymentStatus: paymentObj?.status ?? "settlement_pending",
        ...(paymentObj?.transaction
          ? { transaction: paymentObj.transaction }
          : {}),
      });
    }
    if (!first.ok) {
      const errCode = (result.error as { code?: string } | undefined)?.code;
      if (first.status === 409 && errCode === "IDEMPOTENCY_CONFLICT") {
        throw new McpPaymentError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key reused with different input.",
        );
      }
      throw new McpPaymentError(
        "GATEWAY_REQUEST_FAILED",
        redactSecrets(
          `Gateway returned ${first.status}: ${JSON.stringify(result)}`,
        ),
      );
    }
    return formatSettledInvokeResult(result as unknown as GatewayPaidResponse, {
      amountAtomic: grant.pinnedPriceAtomic,
      payer: payerAddress,
      creatorPayTo: grant.creatorPayTo,
    });
  }

  const challenge = first.headers.get("PAYMENT-REQUIRED");
  if (!challenge) {
    throw new McpPaymentError(
      "PAYMENT_CHALLENGE_MISSING",
      "Gateway returned 402 without a PAYMENT-REQUIRED header.",
    );
  }

  const required = validateChallengeForGrant(challenge, grant, facetVersionId);
  const option = required.accepts[0]!;
  const amountAtomic = option.amount;
  const runKey = `${facetVersionId}:${idempotencyKey}`;

  const existingEntries = await runtime.spendLedger.list({ facetVersionId });
  const existingEntry = existingEntries.find((e) => e.runKey === runKey);
  const hadActiveEntry =
    existingEntry?.status === "PENDING" || existingEntry?.status === "SETTLED";

  if (!hadActiveEntry) {
    const walletStatus = await readFujiWalletStatus(payerAddress, {
      client: runtime.fujiClient,
    });
    if (BigInt(walletStatus.balanceAtomic) < BigInt(amountAtomic)) {
      throw new McpPaymentError(
        "INSUFFICIENT_FUSD_BALANCE",
        `Insufficient Fuji fUSD balance (${walletStatus.balanceAtomic} atomic) for required ${amountAtomic} atomic payment.`,
      );
    }
  }

  await runtime.spendLedger.reserve(runKey, amountAtomic, {
    dailyCapAtomic: grant.dailyCapAtomic,
    maxPerRunAtomic: grant.maxPerRunAtomic,
    facetId: grant.facetId,
    facetVersionId,
    payer: payerAddress,
    creatorPayTo: grant.creatorPayTo,
  });

  let paymentHeader: string;
  try {
    const account = await runtime.walletStore.loadWalletAccount();
    const client = x402Client.fromConfig({
      schemes: [
        {
          network: "eip155:43113",
          client: new ExactEvmScheme(account),
        },
      ],
      spendControls: {
        allowedAssets: [
          {
            network: "eip155:43113",
            asset: grant.assetAddress,
            maxAmountPerPayment: grant.maxPerRunAtomic,
          },
        ],
      },
    });
    const payload = await client.createPaymentPayload(required);
    paymentHeader = encodePaymentSignatureHeader(payload);
  } catch (error) {
    if (!hadActiveEntry) {
      await runtime.spendLedger
        .release(runKey, "SIGNING_FAILED")
        .catch(() => {});
    }
    throw error;
  }

  let paid: Response;
  try {
    paid = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "PAYMENT-SIGNATURE": paymentHeader,
      },
      body,
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      // Keep reservation PENDING on uncertain timeout so daily cap stays locked until retry/reconcile.
      return formatPendingInvokeResult({
        facetVersionId,
        idempotencyKey,
        amountAtomic,
        paymentStatus: "timeout_pending",
      });
    }
    throw error;
  }

  const paidBody = (await paid.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (paid.status === 202) {
    const paymentObj = paidBody.payment as
      { status?: string; transaction?: string } | undefined;
    return formatPendingInvokeResult({
      ...(typeof paidBody.runId === "string" ? { runId: paidBody.runId } : {}),
      facetVersionId,
      idempotencyKey,
      amountAtomic,
      paymentStatus: paymentObj?.status ?? "settlement_pending",
      ...(paymentObj?.transaction
        ? { transaction: paymentObj.transaction }
        : {}),
    });
  }

  if (paid.status === 409) {
    const errCode = (paidBody.error as { code?: string } | undefined)?.code;
    if (errCode === "IDEMPOTENCY_CONFLICT") {
      if (!hadActiveEntry) {
        await runtime.spendLedger
          .release(runKey, "IDEMPOTENCY_CONFLICT")
          .catch(() => {});
      }
      throw new McpPaymentError(
        "IDEMPOTENCY_CONFLICT",
        "Idempotency key was already used with a different input.",
      );
    }
    throw new McpPaymentError(
      "GATEWAY_REQUEST_FAILED",
      redactSecrets(`Gateway returned 409: ${JSON.stringify(paidBody)}`),
    );
  }

  if (!paid.ok) {
    if (!hadActiveEntry && (paid.status === 400 || paid.status === 402)) {
      await runtime.spendLedger
        .release(runKey, `HTTP_${paid.status}`)
        .catch(() => {});
    }
    throw new McpPaymentError(
      "GATEWAY_REQUEST_FAILED",
      redactSecrets(
        `Gateway returned ${paid.status}: ${JSON.stringify(paidBody)}`,
      ),
    );
  }

  const settled = paidBody as unknown as GatewayPaidResponse;
  const paymentTx = settled.payment?.transaction;
  const receiptTx = settled.receipt?.receiptTxHash;
  if (!paymentTx || !receiptTx) {
    return formatPendingInvokeResult({
      runId: settled.runId,
      facetVersionId,
      idempotencyKey,
      amountAtomic,
      paymentStatus: "receipt_pending",
      ...(paymentTx ? { transaction: paymentTx } : {}),
    });
  }

  try {
    await runtime.spendLedger.confirm(runKey, {
      paymentTxHash: paymentTx,
      receiptTxHash: receiptTx,
      runId: settled.runId,
      payer: settled.payment?.payer ?? payerAddress,
      creatorPayTo: settled.payment?.creatorPayTo ?? grant.creatorPayTo,
    });
  } catch (error) {
    if (
      !(error instanceof SpendLedgerError) ||
      error.code !== "RESERVATION_ALREADY_SETTLED"
    ) {
      throw error;
    }
  }

  return formatSettledInvokeResult(settled, {
    amountAtomic,
    payer: payerAddress,
    creatorPayTo: grant.creatorPayTo,
  });
}
