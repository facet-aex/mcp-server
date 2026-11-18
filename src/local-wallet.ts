import {
  PolicyStore,
  SpendLedger,
  WalletStore,
  createViemFujiClient,
  defaultPolicyStorePath,
  defaultSpendLedgerPath,
  formatFusdAtomic,
  resolveProfileName,
  type FujiRpcClient,
} from "@facet-aex/cli";

export const SNOWTRACE_TX_BASE = "https://testnet.snowtrace.io/tx/" as const;

export interface LocalBuyerRuntime {
  profile: string;
  walletStore: WalletStore;
  policyStore: PolicyStore;
  spendLedger: SpendLedger;
  fujiClient: FujiRpcClient;
}

export function createLocalBuyerRuntime(
  options: {
    profile?: string;
    walletStore?: WalletStore;
    policyStore?: PolicyStore;
    spendLedger?: SpendLedger;
    fujiClient?: FujiRpcClient;
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
  };
}

export function snowtraceTxUrl(txHash: string): string {
  return `${SNOWTRACE_TX_BASE}${txHash}`;
}

export interface GatewayPaidResponse {
  runId: string;
  facetVersionId: string;
  facetFullName?: string;
  displayVersion?: string;
  facetType?: string;
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
    amountAtomic?: string;
    payer?: string;
    creatorPayTo?: string;
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
    amountAtomic: string;
    payer: string;
    creatorPayTo: string;
  },
): Record<string, unknown> {
  const paymentTx = body.payment?.transaction;
  const receiptTx = body.receipt?.receiptTxHash;
  const amountAtomic = body.payment?.amountAtomic ?? fallback.amountAtomic;
  const payer = body.payment?.payer ?? fallback.payer;
  const creatorPayTo = body.payment?.creatorPayTo ?? fallback.creatorPayTo;

  return {
    status: "SETTLED",
    runId: body.runId,
    facetVersionId: body.facetVersionId,
    ...(body.facetFullName ? { facetFullName: body.facetFullName } : {}),
    ...(body.displayVersion ? { displayVersion: body.displayVersion } : {}),
    ...(body.facetType ? { facetType: body.facetType } : {}),
    result: body.result,
    ...(body.dataset ? { dataset: body.dataset } : {}),
    ...(body.usage ? { usage: body.usage } : {}),
    replayed: body.replayed,
    payment: {
      transaction: paymentTx,
      network: body.payment?.network ?? "eip155:43113",
      amountAtomic,
      amountFormatted: formatFusdAtomic(BigInt(amountAtomic)),
      payer,
      creatorPayTo,
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
  facetVersionId: string;
  idempotencyKey: string;
  amountAtomic: string;
  paymentStatus: string;
  transaction?: string;
}): Record<string, unknown> {
  return {
    status: "PENDING",
    ...(options.runId ? { runId: options.runId } : {}),
    facetVersionId: options.facetVersionId,
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
    note: "Settlement or receipt confirmation is pending. Retry invoke_facet with the same idempotencyKey and input to reconcile without a second charge.",
  };
}
