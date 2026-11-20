import {
  PolicyStore,
  SpendLedger,
  WalletStore,
  createViemFujiClient,
  defaultPolicyStorePath,
  defaultSpendLedgerPath,
  formatFusdAtomic,
  resolveProfileName,
  type FacetType,
  type FujiRpcClient,
  type PricingModel,
} from "@facet-aex/cli";

export const SNOWTRACE_TX_BASE = "https://testnet.snowtrace.io/tx/" as const;

export interface RetainedPaymentSignature {
  inputFingerprint: string;
  pricingModel?: PricingModel;
  paymentHeader: string;
  amountAtomic: string;
}

export interface LocalBuyerRuntime {
  profile: string;
  walletStore: WalletStore;
  policyStore: PolicyStore;
  spendLedger: SpendLedger;
  fujiClient: FujiRpcClient;
  retainedPaymentSignatures: Map<string, RetainedPaymentSignature>;
}

export function createLocalBuyerRuntime(
  options: {
    profile?: string;
    walletStore?: WalletStore;
    policyStore?: PolicyStore;
    spendLedger?: SpendLedger;
    fujiClient?: FujiRpcClient;
    retainedPaymentSignatures?: Map<string, RetainedPaymentSignature>;
    env?: NodeJS.ProcessEnv;
  } = {},
): LocalBuyerRuntime {
  const env = options.env ?? process.env;
  const profile = resolveProfileName(options.profile, env);

  return {
    profile,
    walletStore: options.walletStore ?? new WalletStore({ profile }),
    policyStore:
      options.policyStore ??
      new PolicyStore({
        profile,
        filePath: defaultPolicyStorePath(env, profile),
      }),
    spendLedger:
      options.spendLedger ??
      new SpendLedger({
        filePath: defaultSpendLedgerPath(env, profile),
      }),
    fujiClient:
      options.fujiClient ?? createViemFujiClient(env.FACET_FUJI_RPC_URL),
    retainedPaymentSignatures: options.retainedPaymentSignatures ?? new Map(),
  };
}

export function snowtraceTxUrl(txHash: string): string {
  return `${SNOWTRACE_TX_BASE}${txHash}`;
}

export interface GatewayPaidResponse {
  runId: string;
  provider?: string;
  facetName?: string;
  facetDisplayName?: string;
  version?: string;
  facetType?: FacetType;
  result: unknown;
  dataset?: Record<string, unknown>[];
  usage?: {
    itemCount: number;
    durationMs: number;
    outputHash?: string;
    runnerSignature?: string;
  };
  replayed: boolean;
  payment?: {
    transaction: string;
    network: string;
    pricingModel?: PricingModel;
    amountAtomic?: string;
    unitPriceAtomic?: string;
    maxItemsCap?: number;
    depositedAmountAtomic?: string;
    refundAmountAtomic?: string;
    depositTxHash?: string;
    payer?: string;
    providerPayTo?: string;
    payTo?: string;
  };
  receipt?: {
    inputHash: string;
    outputHash: string;
    itemCount: number;
    paymentTxHash: string;
    receiptTxHash?: string;
    runnerSignature: string;
  };
}

export function formatSettledInvokeResult(
  body: GatewayPaidResponse,
  fallback: {
    provider: string;
    facetName: string;
    facetDisplayName: string;
    version: string;
    facetType: FacetType;
    pricingModel?: PricingModel;
    unitPriceAtomic?: string;
    maxItemsCap?: number;
    depositedAmountAtomic?: string;
    amountAtomic: string;
    payer: string;
    providerPayTo: string;
  },
): Record<string, unknown> {
  const paymentTx = body.payment?.transaction;
  const depositTx = body.payment?.depositTxHash;
  const receiptTx = body.receipt?.receiptTxHash;
  const amountAtomic = body.payment?.amountAtomic ?? fallback.amountAtomic;
  const pricingModel = body.payment?.pricingModel ?? fallback.pricingModel;
  const unitPriceAtomic =
    body.payment?.unitPriceAtomic ??
    (pricingModel === "PAY_PER_RESULT" ? fallback.unitPriceAtomic : undefined);
  const maxItemsCap =
    body.payment?.maxItemsCap ??
    (pricingModel === "PAY_PER_RESULT" ? fallback.maxItemsCap : undefined);
  const depositedAmountAtomic =
    body.payment?.depositedAmountAtomic ??
    fallback.depositedAmountAtomic ??
    (pricingModel === "PAY_PER_RESULT" ? fallback.amountAtomic : undefined);
  const computedRefundAtomic =
    pricingModel === "PAY_PER_RESULT" && depositedAmountAtomic !== undefined
      ? BigInt(depositedAmountAtomic) - BigInt(amountAtomic)
      : undefined;
  const refundAmountAtomic =
    body.payment?.refundAmountAtomic ??
    (computedRefundAtomic !== undefined && computedRefundAtomic >= 0n
      ? computedRefundAtomic.toString()
      : undefined);
  const payer = body.payment?.payer ?? fallback.payer;
  const providerPayTo = body.payment?.providerPayTo ?? fallback.providerPayTo;

  return {
    status: "SETTLED",
    runId: body.runId,
    provider: body.provider ?? fallback.provider,
    facetName: body.facetName ?? fallback.facetName,
    facetDisplayName: body.facetDisplayName ?? fallback.facetDisplayName,
    version: body.version ?? fallback.version,
    facetType: body.facetType ?? fallback.facetType,
    result: body.result,
    ...(body.dataset ? { dataset: body.dataset } : {}),
    ...(body.usage ? { usage: body.usage } : {}),
    replayed: body.replayed,
    payment: {
      transaction: paymentTx,
      network: body.payment?.network ?? "eip155:43113",
      ...(pricingModel ? { pricingModel } : {}),
      amountAtomic,
      amountFormatted: formatFusdAtomic(BigInt(amountAtomic)),
      ...(unitPriceAtomic !== undefined
        ? {
            unitPriceAtomic,
            unitPriceFormatted: formatFusdAtomic(BigInt(unitPriceAtomic)),
          }
        : {}),
      ...(maxItemsCap !== undefined ? { maxItemsCap } : {}),
      ...(depositedAmountAtomic !== undefined
        ? {
            depositedAmountAtomic,
            depositedAmountFormatted: formatFusdAtomic(
              BigInt(depositedAmountAtomic),
            ),
          }
        : {}),
      ...(refundAmountAtomic !== undefined
        ? {
            refundAmountAtomic,
            refundAmountFormatted: formatFusdAtomic(BigInt(refundAmountAtomic)),
          }
        : {}),
      ...(depositTx
        ? {
            depositTxHash: depositTx,
            depositSnowtraceUrl: snowtraceTxUrl(depositTx),
          }
        : {}),
      payer,
      providerPayTo,
      ...(paymentTx ? { snowtraceUrl: snowtraceTxUrl(paymentTx) } : {}),
    },
    ...(body.receipt
      ? {
          receipt: {
            ...body.receipt,
            ...(receiptTx ? { snowtraceUrl: snowtraceTxUrl(receiptTx) } : {}),
          },
        }
      : {}),
  };
}

export function formatPendingInvokeResult(options: {
  runId?: string;
  provider: string;
  facetName: string;
  facetDisplayName: string;
  version: string;
  facetType: FacetType;
  idempotencyKey: string;
  amountAtomic: string;
  paymentStatus: string;
  transaction?: string;
}): Record<string, unknown> {
  return {
    status: "PENDING",
    ...(options.runId ? { runId: options.runId } : {}),
    provider: options.provider,
    facetName: options.facetName,
    facetDisplayName: options.facetDisplayName,
    version: options.version,
    facetType: options.facetType,
    idempotencyKey: options.idempotencyKey,
    amountAtomic: options.amountAtomic,
    amountFormatted: formatFusdAtomic(BigInt(options.amountAtomic)),
    payment: {
      status: options.paymentStatus,
      ...(options.transaction
        ? {
            transaction: options.transaction,
            snowtraceUrl: snowtraceTxUrl(options.transaction),
          }
        : {}),
    },
    note: "Settlement or receipt confirmation is pending. Retry invoke_facet with the same provider, facetName, version, idempotencyKey, and input to reconcile without a second charge.",
  };
}
