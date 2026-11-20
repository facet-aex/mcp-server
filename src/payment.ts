import { createHash } from "node:crypto";
import {
  FacetClient,
  SpendLedgerError,
  SpendPolicyError,
  getGrantPricingOptions,
  isValidFacetName,
  isValidPricingModel,
  isValidSemver,
  isValidUsername,
  readFujiWalletStatus,
  redactSecrets,
  validateGrantAgainstChallenge,
  type PinnedPricingOption,
  type PricingModel,
  type PublicFacetRecord,
  type SpendPolicyGrant,
} from "@facet-aex/cli";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  formatPendingInvokeResult,
  formatSettledInvokeResult,
  type GatewayPaidResponse,
  type LocalBuyerRuntime,
} from "./local-wallet.js";

const MAX_RETAINED_PAYMENT_SIGNATURES = 256;
const NON_NEGATIVE_ATOMIC_REGEX = /^(?:0|[1-9][0-9]*)$/u;

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

export interface ValidatedChallengeResult {
  narrowedRequired: PaymentRequired;
  selectedOption: PaymentRequirements;
  pricingModel: PricingModel;
  unitPriceAtomic: string;
  maxItemsCap?: number;
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

function fingerprintInput(
  input: Record<string, unknown>,
  pricingModel?: PricingModel,
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        input,
        ...(pricingModel ? { pricingModel } : {}),
      }),
    )
    .digest("hex");
}

function buildInvokePath(target: FacetTargetRef): string {
  return `/v1/facets/${encodeURIComponent(target.provider)}/${encodeURIComponent(target.facetName)}/versions/${encodeURIComponent(target.version)}/invoke`;
}

function cacheRetainedSignature(
  runtime: LocalBuyerRuntime,
  runKey: string,
  entry: {
    inputFingerprint: string;
    pricingModel?: PricingModel;
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

function isFacetExactOption(option: PaymentRequirements | undefined): boolean {
  return Boolean(
    option &&
    option.scheme === "exact" &&
    option.extra?.name === "FACET USD" &&
    option.extra?.version === "2",
  );
}

function selectChallengeOption(
  candidates: PaymentRequirements[],
  grant: SpendPolicyGrant,
  pinnedOptions: PinnedPricingOption[],
  requestedPricingModel?: PricingModel,
): PaymentRequirements {
  const pinnedModels = new Set(pinnedOptions.map((opt) => opt.model));

  if (candidates.length > 1) {
    const seenModels = new Set<PricingModel>();
    for (const candidate of candidates) {
      const candidateModel = candidate.extra?.pricingModel;
      if (
        typeof candidateModel !== "string" ||
        !isValidPricingModel(candidateModel)
      ) {
        throw new McpPaymentError(
          "PAYMENT_CHALLENGE_NOT_ALLOWED",
          "Gateway multi-option payment challenge entry is missing a valid pricingModel.",
        );
      }
      if (seenModels.has(candidateModel)) {
        throw new McpPaymentError(
          "PAYMENT_CHALLENGE_NOT_ALLOWED",
          `Gateway payment challenge contains duplicate pricingModel '${candidateModel}'.`,
        );
      }
      seenModels.add(candidateModel);
    }
  } else {
    const singleModel = candidates[0]?.extra?.pricingModel;
    if (
      singleModel !== undefined &&
      (typeof singleModel !== "string" || !isValidPricingModel(singleModel))
    ) {
      throw new McpPaymentError(
        "PAYMENT_CHALLENGE_NOT_ALLOWED",
        "Gateway returned an unsupported pricingModel in x402 v2 payment challenge.",
      );
    }
  }

  if (requestedPricingModel !== undefined) {
    if (!pinnedModels.has(requestedPricingModel)) {
      throw new SpendPolicyError(
        "POLICY_PRICE_MISMATCH",
        `Pricing model ${requestedPricingModel} is not authorized in this spending policy grant.`,
      );
    }
    const matched = candidates.find(
      (opt) => opt.extra?.pricingModel === requestedPricingModel,
    );
    if (!matched) {
      throw new McpPaymentError(
        "PAYMENT_CHALLENGE_NOT_ALLOWED",
        `Gateway payment challenge does not offer requested pricingModel '${requestedPricingModel}'.`,
      );
    }
    return matched;
  }

  if (candidates.length === 1) {
    return candidates[0]!;
  }

  const grantedCandidates = candidates.filter((opt) =>
    pinnedModels.has(opt.extra.pricingModel as PricingModel),
  );
  if (grantedCandidates.length === 0) {
    throw new SpendPolicyError(
      "POLICY_PRICE_MISMATCH",
      "None of the Gateway pricing options are authorized in this spending policy grant.",
    );
  }
  if (grantedCandidates.length === 1) {
    return grantedCandidates[0]!;
  }

  const primaryMatch = grantedCandidates.find(
    (opt) => opt.extra.pricingModel === grant.pricingModel,
  );
  if (!primaryMatch) {
    throw new McpPaymentError(
      "PAYMENT_CHALLENGE_NOT_ALLOWED",
      "Gateway payment challenge offers multiple granted pricing options without a matching primary option.",
    );
  }
  return primaryMatch;
}

export function validateChallengeForGrant(
  grant: SpendPolicyGrant,
  required: PaymentRequired | string,
  expectedTarget: FacetTargetRef,
  requestedPricingModel?: PricingModel,
): ValidatedChallengeResult;
export function validateChallengeForGrant(
  header: string,
  grant: SpendPolicyGrant,
  expectedTarget: FacetTargetRef,
  requestedPricingModel?: PricingModel,
): ValidatedChallengeResult;
export function validateChallengeForGrant(
  grantOrHeader: SpendPolicyGrant | string,
  requiredOrGrant: PaymentRequired | string | SpendPolicyGrant,
  expectedTarget: FacetTargetRef,
  requestedPricingModel?: PricingModel,
): ValidatedChallengeResult {
  let grant: SpendPolicyGrant;
  let required: PaymentRequired;
  if (typeof grantOrHeader === "string") {
    grant = requiredOrGrant as SpendPolicyGrant;
    required = decodePaymentRequiredHeader(grantOrHeader);
  } else {
    grant = grantOrHeader;
    required =
      typeof requiredOrGrant === "string"
        ? decodePaymentRequiredHeader(requiredOrGrant)
        : (requiredOrGrant as PaymentRequired);
  }

  if (
    required.x402Version !== 2 ||
    !Array.isArray(required.accepts) ||
    required.accepts.length < 1
  ) {
    throw new McpPaymentError(
      "PAYMENT_CHALLENGE_NOT_ALLOWED",
      "Gateway returned an unsupported x402 v2 payment challenge.",
    );
  }

  if (
    requestedPricingModel !== undefined &&
    !isValidPricingModel(requestedPricingModel)
  ) {
    throw new SpendPolicyError(
      "POLICY_INVALID",
      `Invalid pricingModel '${String(requestedPricingModel)}'. Expected PAY_PER_RUN or PAY_PER_RESULT.`,
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

  const candidates = required.accepts.filter((option) =>
    isFacetExactOption(option),
  );
  if (candidates.length === 0) {
    throw new McpPaymentError(
      "PAYMENT_CHALLENGE_NOT_ALLOWED",
      "Gateway returned an unsupported x402 v2 payment challenge.",
    );
  }

  const pinnedOptions = getGrantPricingOptions(grant);
  const selectedOption = selectChallengeOption(
    candidates,
    grant,
    pinnedOptions,
    requestedPricingModel,
  );

  const networkParts = selectedOption.network.split(":");
  const chainId =
    networkParts[0] === "eip155" && /^[0-9]+$/u.test(networkParts[1] ?? "")
      ? Number(networkParts[1])
      : -1;

  const rawProviderPayTo = selectedOption.extra?.providerPayTo;
  if (rawProviderPayTo !== undefined && typeof rawProviderPayTo !== "string") {
    throw new SpendPolicyError(
      "POLICY_RECIPIENT_MISMATCH",
      "Payment challenge extra.providerPayTo must be an EVM address string.",
    );
  }

  const rawPricingModel = selectedOption.extra?.pricingModel;
  const challengePricingModel =
    typeof rawPricingModel === "string"
      ? (rawPricingModel as PricingModel)
      : undefined;

  const rawUnitPrice = selectedOption.extra?.unitPriceAtomic;
  if (rawUnitPrice !== undefined && typeof rawUnitPrice !== "string") {
    throw new SpendPolicyError(
      "POLICY_PRICE_MISMATCH",
      "Payment challenge extra.unitPriceAtomic must be an atomic string.",
    );
  }

  const rawMaxItemsCap = selectedOption.extra?.maxItemsCap;
  if (rawMaxItemsCap !== undefined && typeof rawMaxItemsCap !== "number") {
    throw new SpendPolicyError(
      "POLICY_PRICE_MISMATCH",
      "Payment challenge extra.maxItemsCap must be an integer.",
    );
  }

  validateGrantAgainstChallenge(grant, {
    provider: expectedTarget.provider,
    facetName: expectedTarget.facetName,
    version: expectedTarget.version,
    chainId,
    assetAddress: selectedOption.asset,
    settlementPayTo: selectedOption.payTo,
    ...(rawProviderPayTo !== undefined
      ? { providerPayTo: rawProviderPayTo }
      : {}),
    amountAtomic: selectedOption.amount,
    ...(challengePricingModel !== undefined
      ? { pricingModel: challengePricingModel }
      : {}),
    ...(rawUnitPrice !== undefined ? { unitPriceAtomic: rawUnitPrice } : {}),
    ...(rawMaxItemsCap !== undefined ? { maxItemsCap: rawMaxItemsCap } : {}),
  });

  const matchedGrantOption =
    (challengePricingModel
      ? pinnedOptions.find((opt) => opt.model === challengePricingModel)
      : undefined) ?? pinnedOptions[0]!;
  const resolvedPricingModel =
    challengePricingModel ?? matchedGrantOption.model;
  const resolvedUnitPriceAtomic =
    rawUnitPrice ?? matchedGrantOption.priceAtomic;
  const resolvedMaxItemsCap =
    rawMaxItemsCap !== undefined
      ? rawMaxItemsCap
      : matchedGrantOption.maxItemsCap;

  const narrowedRequired: PaymentRequired = {
    ...required,
    accepts: [selectedOption],
  };

  return {
    narrowedRequired,
    selectedOption,
    pricingModel: resolvedPricingModel,
    unitPriceAtomic: resolvedUnitPriceAtomic,
    ...(resolvedMaxItemsCap !== undefined
      ? { maxItemsCap: resolvedMaxItemsCap }
      : {}),
  };
}

export function verifyCatalogPin(
  facet: PublicFacetRecord,
  grant: SpendPolicyGrant,
): PublicFacetRecord {
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

  const catalogPricingOptions =
    Array.isArray(facet.pricingOptions) && facet.pricingOptions.length > 0
      ? facet.pricingOptions
      : facet.pricing
        ? [facet.pricing]
        : [];
  if (catalogPricingOptions.length === 0) {
    throw new McpPaymentError(
      "FACET_CATALOG_MISMATCH",
      "Catalog Facet is missing pricing metadata.",
    );
  }
  for (const option of catalogPricingOptions) {
    if (option.payTo.toLowerCase() !== grant.providerPayTo.toLowerCase()) {
      throw new SpendPolicyError(
        "POLICY_RECIPIENT_MISMATCH",
        `Catalog provider payTo ${option.payTo} does not match pinned grant ${grant.providerPayTo}.`,
      );
    }
  }
  if (
    facet.pricing &&
    facet.pricing.payTo.toLowerCase() !== grant.providerPayTo.toLowerCase()
  ) {
    throw new SpendPolicyError(
      "POLICY_RECIPIENT_MISMATCH",
      `Catalog provider payTo ${facet.pricing.payTo} does not match pinned grant ${grant.providerPayTo}.`,
    );
  }

  const registryMeta =
    facet.facetType === "ACTOR"
      ? facet.actorMeta
      : facet.facetType === "AGENT"
        ? facet.agentMeta
        : facet.facetType === "API"
          ? facet.apiMeta
          : undefined;
  if (registryMeta?.registryVerified !== true) {
    throw new SpendPolicyError(
      "UNVERIFIED_FACET_REGISTRY",
      "Catalog Facet is not marked registryVerified on Avalanche.",
    );
  }
  if (
    !registryMeta.registryTxHash ||
    registryMeta.registryTxHash.toLowerCase() !==
      grant.registryTxHash.toLowerCase()
  ) {
    throw new McpPaymentError(
      "FACET_CATALOG_MISMATCH",
      `Catalog registryTxHash ${registryMeta.registryTxHash ?? "(missing)"} does not match pinned grant ${grant.registryTxHash}.`,
    );
  }
  return facet;
}

async function fetchAndVerifyCatalogPin(
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
  return verifyCatalogPin(facet, grant);
}

async function releaseRefundIfConfirmed(
  runtime: LocalBuyerRuntime,
  runKey: string,
  status: number,
  body: Record<string, unknown>,
): Promise<boolean> {
  if (status !== 502) return false;
  const paymentObj = body.payment as
    | {
        status?: string;
        transaction?: string;
        refundAmountAtomic?: string;
      }
    | undefined;
  if (paymentObj?.status !== "refunded") return false;

  runtime.retainedPaymentSignatures.delete(runKey);
  await runtime.spendLedger
    .release(runKey, "ESCROW_REFUNDED", {
      ...(typeof paymentObj.transaction === "string" && paymentObj.transaction
        ? { refundTxHash: paymentObj.transaction }
        : {}),
      ...(typeof paymentObj.refundAmountAtomic === "string" &&
      NON_NEGATIVE_ATOMIC_REGEX.test(paymentObj.refundAmountAtomic)
        ? { refundAmountAtomic: paymentObj.refundAmountAtomic }
        : {}),
    })
    .catch(() => {});
  return true;
}

async function confirmAndFormatSettled(params: {
  runtime: LocalBuyerRuntime;
  runKey: string;
  settled: GatewayPaidResponse;
  grant: SpendPolicyGrant;
  provider: string;
  facetName: string;
  version: string;
  idempotencyKey: string;
  payerAddress: string;
  selectedPricingModel: PricingModel;
  selectedUnitPriceAtomic: string;
  selectedMaxItemsCap?: number;
  amountAtomic: string;
  shouldConfirmLedger: boolean;
}): Promise<Record<string, unknown>> {
  const {
    runtime,
    runKey,
    settled,
    grant,
    provider,
    facetName,
    version,
    idempotencyKey,
    payerAddress,
    selectedPricingModel,
    selectedUnitPriceAtomic,
    selectedMaxItemsCap,
    amountAtomic,
    shouldConfirmLedger,
  } = params;

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

  const resolvedPricingModel =
    settled.payment?.pricingModel ?? selectedPricingModel;
  const resolvedDepositedAmountAtomic =
    settled.payment?.depositedAmountAtomic ??
    (resolvedPricingModel === "PAY_PER_RESULT" ? amountAtomic : undefined);
  const settledAmountAtomic = settled.payment?.amountAtomic;
  const resolvedRefundAmountAtomic =
    settled.payment?.refundAmountAtomic ??
    (resolvedPricingModel === "PAY_PER_RESULT" &&
    resolvedDepositedAmountAtomic !== undefined &&
    settledAmountAtomic !== undefined
      ? (() => {
          const diff =
            BigInt(resolvedDepositedAmountAtomic) - BigInt(settledAmountAtomic);
          return diff >= 0n ? diff.toString() : undefined;
        })()
      : undefined);
  const resolvedItemCount =
    settled.usage?.itemCount ?? settled.receipt?.itemCount;
  const resolvedDepositTxHash = settled.payment?.depositTxHash;

  if (shouldConfirmLedger) {
    try {
      await runtime.spendLedger.confirm(runKey, {
        paymentTxHash: paymentTx,
        receiptTxHash: receiptTx,
        ...(resolvedDepositTxHash
          ? { depositTxHash: resolvedDepositTxHash }
          : {}),
        ...(settledAmountAtomic !== undefined
          ? { amountAtomic: settledAmountAtomic }
          : {}),
        pricingModel: resolvedPricingModel,
        ...(resolvedDepositedAmountAtomic !== undefined
          ? { depositedAmountAtomic: resolvedDepositedAmountAtomic }
          : {}),
        ...(resolvedRefundAmountAtomic !== undefined
          ? { refundAmountAtomic: resolvedRefundAmountAtomic }
          : {}),
        ...(resolvedItemCount !== undefined
          ? { itemCount: resolvedItemCount }
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
  }

  return formatSettledInvokeResult(settled, {
    provider,
    facetName,
    facetDisplayName: grant.facetDisplayName,
    version,
    facetType: grant.facetType,
    pricingModel: resolvedPricingModel,
    ...(resolvedPricingModel === "PAY_PER_RESULT"
      ? {
          unitPriceAtomic: selectedUnitPriceAtomic,
          ...(selectedMaxItemsCap !== undefined
            ? { maxItemsCap: selectedMaxItemsCap }
            : {}),
          ...(resolvedDepositedAmountAtomic !== undefined
            ? { depositedAmountAtomic: resolvedDepositedAmountAtomic }
            : {}),
        }
      : {}),
    amountAtomic,
    payer: payerAddress,
    providerPayTo: grant.providerPayTo,
  });
}

export interface InvokeWithPaymentOptions {
  controlUrl: string;
  gatewayUrl: string;
  provider: string;
  facetName: string;
  version: string;
  input: Record<string, unknown>;
  pricingModel?: PricingModel;
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
    pricingModel,
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
  if (pricingModel !== undefined && !isValidPricingModel(pricingModel)) {
    throw new SpendPolicyError(
      "POLICY_INVALID",
      `Invalid pricingModel '${String(pricingModel)}'. Expected PAY_PER_RUN or PAY_PER_RESULT.`,
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

  const pinnedOptions = getGrantPricingOptions(grant);
  const preflightOption = pricingModel
    ? pinnedOptions.find((option) => option.model === pricingModel)
    : (pinnedOptions.find((option) => option.model === grant.pricingModel) ??
      pinnedOptions[0]);
  if (!preflightOption) {
    throw new SpendPolicyError(
      "POLICY_PRICE_MISMATCH",
      `Pricing model ${pricingModel} is not authorized in this spending policy grant.`,
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
    pricingModel: preflightOption.model,
    unitPriceAtomic: preflightOption.priceAtomic,
    ...(preflightOption.maxItemsCap !== undefined
      ? { maxItemsCap: preflightOption.maxItemsCap }
      : {}),
    amountAtomic: preflightOption.maxAmountAtomic,
  });
  await fetchAndVerifyCatalogPin(controlUrl, grant);

  const url = new URL(
    buildInvokePath({ provider, facetName, version }),
    gatewayUrl,
  );
  const headers = {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
  const body = JSON.stringify({
    input,
    ...(pricingModel ? { pricingModel } : {}),
  });
  const inputFingerprint = fingerprintInput(input, pricingModel);
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
  let selectedPricingModel: PricingModel;
  let selectedUnitPriceAtomic: string;
  let selectedMaxItemsCap: number | undefined;

  if (
    hadActiveEntry &&
    retained &&
    retained.inputFingerprint === inputFingerprint &&
    (!pricingModel ||
      !retained.pricingModel ||
      retained.pricingModel === pricingModel)
  ) {
    amountAtomic = retained.amountAtomic;
    paymentHeader = retained.paymentHeader;
    selectedPricingModel =
      retained.pricingModel ?? pricingModel ?? preflightOption.model;
    const matchedGrantOption =
      pinnedOptions.find((opt) => opt.model === selectedPricingModel) ??
      preflightOption;
    selectedUnitPriceAtomic = matchedGrantOption.priceAtomic;
    selectedMaxItemsCap = matchedGrantOption.maxItemsCap;

    await runtime.spendLedger.reserve(runKey, amountAtomic, {
      dailyCapAtomic: grant.dailyCapAtomic,
      maxPerRunAtomic: grant.maxPerRunAtomic,
      provider,
      facetName,
      facetDisplayName: grant.facetDisplayName,
      version,
      facetType: grant.facetType,
      pricingModel: selectedPricingModel,
      ...(selectedPricingModel === "PAY_PER_RESULT"
        ? { depositedAmountAtomic: amountAtomic }
        : {}),
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
          amountAtomic:
            existingEntry?.amountAtomic ?? preflightOption.maxAmountAtomic,
          paymentStatus: paymentObj?.status ?? "settlement_pending",
          ...(paymentObj?.transaction
            ? { transaction: paymentObj.transaction }
            : {}),
        });
      }
      if (!first.ok) {
        await releaseRefundIfConfirmed(runtime, runKey, first.status, result);
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
      return confirmAndFormatSettled({
        runtime,
        runKey,
        settled: result as unknown as GatewayPaidResponse,
        grant,
        provider,
        facetName,
        version,
        idempotencyKey,
        payerAddress,
        selectedPricingModel:
          existingEntry?.pricingModel ?? preflightOption.model,
        selectedUnitPriceAtomic: preflightOption.priceAtomic,
        selectedMaxItemsCap: preflightOption.maxItemsCap,
        amountAtomic:
          existingEntry?.amountAtomic ?? preflightOption.maxAmountAtomic,
        shouldConfirmLedger: existingEntry?.status === "PENDING",
      });
    }

    const challenge = first.headers.get("PAYMENT-REQUIRED");
    if (!challenge) {
      throw new McpPaymentError(
        "PAYMENT_CHALLENGE_MISSING",
        "Gateway returned 402 without a PAYMENT-REQUIRED header.",
      );
    }

    const decodedRequired = decodePaymentRequiredHeader(challenge);
    const validatedChallenge = validateChallengeForGrant(
      grant,
      decodedRequired,
      {
        provider,
        facetName,
        version,
      },
      pricingModel,
    );
    amountAtomic = validatedChallenge.selectedOption.amount;
    selectedPricingModel = validatedChallenge.pricingModel;
    selectedUnitPriceAtomic = validatedChallenge.unitPriceAtomic;
    selectedMaxItemsCap = validatedChallenge.maxItemsCap;

    if (!hadActiveEntry) {
      const walletStatus = await readFujiWalletStatus(payerAddress, {
        client: runtime.fujiClient,
      });
      if (BigInt(walletStatus.balanceAtomic) < BigInt(amountAtomic)) {
        throw new McpPaymentError(
          "INSUFFICIENT_FUSD_BALANCE",
          `Insufficient Avalanche fUSD balance (${walletStatus.balanceAtomic} atomic) for required ${amountAtomic} atomic payment.`,
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
      pricingModel: selectedPricingModel,
      ...(selectedPricingModel === "PAY_PER_RESULT"
        ? { depositedAmountAtomic: amountAtomic }
        : {}),
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
      const payload = await client.createPaymentPayload(
        validatedChallenge.narrowedRequired,
      );
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
      pricingModel: selectedPricingModel,
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
    const refunded = await releaseRefundIfConfirmed(
      runtime,
      runKey,
      paid.status,
      paidBody,
    );
    if (
      !refunded &&
      !hadActiveEntry &&
      (paid.status === 400 || paid.status === 402)
    ) {
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

  return confirmAndFormatSettled({
    runtime,
    runKey,
    settled: paidBody as unknown as GatewayPaidResponse,
    grant,
    provider,
    facetName,
    version,
    idempotencyKey,
    payerAddress,
    selectedPricingModel,
    selectedUnitPriceAtomic,
    selectedMaxItemsCap,
    amountAtomic,
    shouldConfirmLedger: true,
  });
}
