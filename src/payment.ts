import { createHash } from "node:crypto";
import {
  FacetClient,
  SpendLedgerError,
  SpendPolicyError,
  isValidFacetName,
  isValidSemver,
  isValidUsername,
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

const MAX_RETAINED_PAYMENT_SIGNATURES = 256;

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

export interface FacetTargetRef {
  provider: string;
  facetName: string;
  version: string;
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item !== null && typeof item === "object") {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort()) {
        const child = normalize((item as Record<string, unknown>)[key]);
        if (child !== undefined) sorted[key] = child;
      }
      return sorted;
    }
    return item;
  };
  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) {
    throw new McpPaymentError(
      "GATEWAY_REQUEST_FAILED",
      "Unable to serialize invocation input canonically.",
    );
  }
  return serialized;
}

function fingerprintInput(input: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function buildInvokePath(target: FacetTargetRef): string {
  return `/v1/facets/${encodeURIComponent(target.provider)}/${encodeURIComponent(target.facetName)}/versions/${encodeURIComponent(target.version)}/invoke`;
}

function cacheRetainedSignature(
  runtime: LocalBuyerRuntime,
  runKey: string,
  entry: {
    inputFingerprint: string;
    paymentHeader: string;
    amountAtomic: string;
  },
): void {
  if (
    !runtime.retainedPaymentSignatures.has(runKey) &&
    runtime.retainedPaymentSignatures.size >= MAX_RETAINED_PAYMENT_SIGNATURES
  ) {
    const oldestKey = runtime.retainedPaymentSignatures.keys().next().value;
    if (oldestKey !== undefined) {
      runtime.retainedPaymentSignatures.delete(oldestKey);
    }
  }
  runtime.retainedPaymentSignatures.set(runKey, entry);
}

export function validateChallengeForGrant(
  header: string,
  grant: SpendPolicyGrant,
  expectedTarget: FacetTargetRef,
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

  const expectedPath = buildInvokePath(expectedTarget);
  if (resourcePath !== expectedPath) {
    throw new McpPaymentError(
      "PAYMENT_CHALLENGE_NOT_ALLOWED",
      `Payment challenge resource path ${resourcePath} does not match expected target ${expectedPath}.`,
    );
  }

  const networkParts = option.network.split(":");
  const chainId =
    networkParts[0] === "eip155" && /^[0-9]+$/u.test(networkParts[1] ?? "")
      ? Number(networkParts[1])
      : -1;
  const challengeProviderPayTo =
    typeof option.extra?.providerPayTo === "string"
      ? option.extra.providerPayTo
      : undefined;

  validateGrantAgainstChallenge(grant, {
    provider: expectedTarget.provider,
    facetName: expectedTarget.facetName,
    version: expectedTarget.version,
    chainId,
    assetAddress: option.asset,
    settlementPayTo: option.payTo,
    ...(challengeProviderPayTo
      ? { providerPayTo: challengeProviderPayTo }
      : {}),
    amountAtomic: option.amount,
  });

  return required;
}

async function verifyCatalogPin(
  controlUrl: string,
  grant: SpendPolicyGrant,
): Promise<PublicFacetRecord> {
  const client = new FacetClient({ controlApiUrl: controlUrl });
  let facet: PublicFacetRecord | undefined;
  try {
    facet = (await client.getFacet(
      grant.provider,
      grant.facetName,
      grant.version,
    )) as PublicFacetRecord | undefined;
  } catch (error) {
    throw new McpPaymentError(
      "FACET_CATALOG_MISMATCH",
      redactSecrets(
        `Catalog lookup failed for ${grant.provider}/${grant.facetName}@${grant.version}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  if (!facet) {
    throw new McpPaymentError(
      "FACET_CATALOG_MISMATCH",
      `Catalog facet ${grant.provider}/${grant.facetName}@${grant.version} is no longer available.`,
    );
  }
  if (
    facet.provider !== grant.provider ||
    facet.facetName !== grant.facetName ||
    facet.version !== grant.version ||
    facet.facetType !== grant.facetType
  ) {
    throw new McpPaymentError(
      "FACET_CATALOG_MISMATCH",
      `Catalog record ${facet.provider}/${facet.facetName}@${facet.version} (${facet.facetType}) does not match granted immutable target ${grant.provider}/${grant.facetName}@${grant.version} (${grant.facetType}).`,
    );
  }
  if (!facet.pricing) {
    throw new McpPaymentError(
      "FACET_CATALOG_MISMATCH",
      "Catalog Facet is missing pricing metadata.",
    );
  }
  if (facet.pricing.payTo.toLowerCase() !== grant.providerPayTo.toLowerCase()) {
    throw new SpendPolicyError(
      "POLICY_RECIPIENT_MISMATCH",
      `Catalog provider payTo ${facet.pricing.payTo} does not match pinned grant ${grant.providerPayTo}.`,
    );
  }
  const verified =
    facet.facetType === "ACTOR"
      ? facet.actorMeta?.registryVerified === true
      : facet.facetType === "AGENT"
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
  provider: string;
  facetName: string;
  version: string;
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
    provider,
    facetName,
    version,
    input,
    idempotencyKey,
    runtime,
  } = options;

  if (!isValidUsername(provider)) {
    throw new SpendPolicyError(
      "POLICY_INVALID",
      `Invalid provider '${provider}'. Must be 8-16 lowercase hyphenated kebab-case characters.`,
    );
  }
  if (!isValidFacetName(facetName)) {
    throw new SpendPolicyError(
      "POLICY_INVALID",
      `Invalid facetName '${facetName}'. Must be 4-32 lowercase hyphenated kebab-case characters.`,
    );
  }
  if (!isValidSemver(version)) {
    throw new SpendPolicyError(
      "POLICY_INVALID",
      `Invalid version '${version}'. Expected SemVer MAJOR.MINOR.PATCH.`,
    );
  }

  const grant = await runtime.policyStore.findGrant(
    provider,
    facetName,
    version,
  );
  if (!grant) {
    throw new SpendPolicyError(
      "POLICY_NOT_GRANTED",
      `Default-deny: no spending policy granted for ${provider}/${facetName}@${version}. Run \`facet policy grant --provider ${provider} --facet ${facetName} --version ${version}\` first.`,
    );
  }

  // Re-validate non-expired & non-revoked policy and confirm live catalog pin before any call.
  validateGrantAgainstChallenge(grant, {
    provider: grant.provider,
    facetName: grant.facetName,
    version: grant.version,
    chainId: grant.chainId,
    assetAddress: grant.assetAddress,
    settlementPayTo: grant.settlementContract,
    providerPayTo: grant.providerPayTo,
    amountAtomic: grant.pinnedPriceAtomic,
  });
  await verifyCatalogPin(controlUrl, grant);

  const url = new URL(
    buildInvokePath({ provider, facetName, version }),
    gatewayUrl,
  );
  const headers = {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
  const body = JSON.stringify({ input });
  const inputFingerprint = fingerprintInput(input);
  const runKey = `${provider}/${facetName}@${version}:${idempotencyKey}`;

  const payerAddress = await runtime.walletStore.getWalletAddress();
  const existingEntries = await runtime.spendLedger.list({
    provider,
    facetName,
    version,
  });
  const existingEntry = existingEntries.find((e) => e.runKey === runKey);
  const hadActiveEntry =
    existingEntry?.status === "PENDING" || existingEntry?.status === "SETTLED";

  const retained = runtime.retainedPaymentSignatures.get(runKey);
  let amountAtomic: string;
  let paymentHeader: string;

  if (
    hadActiveEntry &&
    retained &&
    retained.inputFingerprint === inputFingerprint
  ) {
    amountAtomic = retained.amountAtomic;
    paymentHeader = retained.paymentHeader;
    await runtime.spendLedger.reserve(runKey, amountAtomic, {
      dailyCapAtomic: grant.dailyCapAtomic,
      maxPerRunAtomic: grant.maxPerRunAtomic,
      provider,
      facetName,
      facetDisplayName: grant.facetDisplayName,
      version,
      facetType: grant.facetType,
      payer: payerAddress,
      providerPayTo: grant.providerPayTo,
    });
  } else {
    const first = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(45_000),
    });

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
          provider,
          facetName,
          facetDisplayName: grant.facetDisplayName,
          version,
          facetType: grant.facetType,
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
      return formatSettledInvokeResult(
        result as unknown as GatewayPaidResponse,
        {
          provider,
          facetName,
          facetDisplayName: grant.facetDisplayName,
          version,
          facetType: grant.facetType,
          amountAtomic: grant.pinnedPriceAtomic,
          payer: payerAddress,
          providerPayTo: grant.providerPayTo,
        },
      );
    }

    const challenge = first.headers.get("PAYMENT-REQUIRED");
    if (!challenge) {
      throw new McpPaymentError(
        "PAYMENT_CHALLENGE_MISSING",
        "Gateway returned 402 without a PAYMENT-REQUIRED header.",
      );
    }

    const required = validateChallengeForGrant(challenge, grant, {
      provider,
      facetName,
      version,
    });
    const option = required.accepts[0]!;
    amountAtomic = option.amount;

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
      provider,
      facetName,
      facetDisplayName: grant.facetDisplayName,
      version,
      facetType: grant.facetType,
      payer: payerAddress,
      providerPayTo: grant.providerPayTo,
    });

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

    cacheRetainedSignature(runtime, runKey, {
      inputFingerprint,
      paymentHeader,
      amountAtomic,
    });
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
      // Keep reservation PENDING and cached PAYMENT-SIGNATURE on uncertain timeout so daily cap stays locked until retry/reconcile.
      return formatPendingInvokeResult({
        provider,
        facetName,
        facetDisplayName: grant.facetDisplayName,
        version,
        facetType: grant.facetType,
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
      provider,
      facetName,
      facetDisplayName: grant.facetDisplayName,
      version,
      facetType: grant.facetType,
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
        runtime.retainedPaymentSignatures.delete(runKey);
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
      runtime.retainedPaymentSignatures.delete(runKey);
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
      provider,
      facetName,
      facetDisplayName: grant.facetDisplayName,
      version,
      facetType: grant.facetType,
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
      ...(settled.payment?.amountAtomic
        ? { amountAtomic: settled.payment.amountAtomic }
        : {}),
      runId: settled.runId,
      payer: settled.payment?.payer ?? payerAddress,
      providerPayTo: settled.payment?.providerPayTo ?? grant.providerPayTo,
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
    provider,
    facetName,
    facetDisplayName: grant.facetDisplayName,
    version,
    facetType: grant.facetType,
    amountAtomic,
    payer: payerAddress,
    providerPayTo: grant.providerPayTo,
  });
}
