import logger from "../../utils/logger";
import * as StellarSdk from "stellar-sdk";
import { getStellarServer, getNetworkPassphrase } from "../../config/stellar";
import { AssetService } from "./assetService";

export interface OperatorAccount {
  publicKey: string;
  name: string;
  role: "hot" | "cold" | "distribution";
}

export interface FloatLimit {
  asset: string;
  assetIssuer: string;
  minBalance: number;
  maxBalance: number;
  rebalanceThresholdPct: number;
}

export interface BalanceSnapshot {
  accountPublicKey: string;
  asset: string;
  assetIssuer: string;
  balance: number;
  timestamp: Date;
}

export interface RebalanceTrigger {
  accountPublicKey: string;
  asset: string;
  assetIssuer: string;
  currentBalance: number;
  limitType: "below_min" | "above_max";
  deficitOrSurplus: number;
  targetBalance: number;
}

export interface RebalancePaymentResult {
  txHash: string | null;
  ledger: number | null;
  fromAccount: string;
  toAccount: string;
  asset: string;
  assetIssuer: string;
  amount: string;
  status: "success" | "failed" | "skipped";
  error?: string;
  loggedAt: Date;
}

export interface TransactionLogEntry {
  txHash: string | null;
  ledger: number | null;
  fromAccount: string;
  toAccount: string;
  asset: string;
  assetIssuer: string;
  amount: string;
  status: "success" | "failed" | "skipped";
  error?: string;
  triggeredBy: "float_limit_breach" | "manual" | "scheduled";
  timestamp: Date;
  processedAt: number;
  durationMs: number;
}

export type BalanceHook = (
  snapshot: BalanceSnapshot,
  previousSnapshot: BalanceSnapshot | null,
) => void;

export type RebalanceTriggerHook = (
  trigger: RebalanceTrigger,
) => Promise<void>;

export interface BalanceTrackerState {
  balances: Map<string, BalanceSnapshot>;
  hooks: BalanceHook[];
  triggerHooks: RebalanceTriggerHook[];
}

function getOperatorAccounts(): OperatorAccount[] {
  const raw = process.env.STELLAR_OPERATOR_ACCOUNTS;
  if (!raw) {
    console.warn(
      "[stellar-payments] STELLAR_OPERATOR_ACCOUNTS not configured",
    );
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as OperatorAccount[];
    return parsed.filter(
      (acc) =>
        acc.publicKey &&
        acc.name &&
        (acc.role === "hot" || acc.role === "cold" || acc.role === "distribution"),
    );
  } catch {
    console.warn("[stellar-payments] Invalid STELLAR_OPERATOR_ACCOUNTS JSON");
    return [];
  }
}

function getFloatLimits(): FloatLimit[] {
  const raw = process.env.STELLAR_FLOAT_LIMITS;
  if (!raw) {
    console.warn(
      "[stellar-payments] STELLAR_FLOAT_LIMITS not configured",
    );
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as FloatLimit[];
    return parsed.filter(
      (limit) =>
        limit.asset &&
        typeof limit.minBalance === "number" &&
        typeof limit.maxBalance === "number" &&
        limit.maxBalance > limit.minBalance,
    );
  } catch {
    console.warn("[stellar-payments] Invalid STELLAR_FLOAT_LIMITS JSON");
    return [];
  }
}

function getRebalanceSourceAccount(): string | null {
  const secret = process.env.STELLAR_REBALANCE_SOURCE_SECRET?.trim();
  if (!secret) return null;
  try {
    const keypair = StellarSdk.Keypair.fromSecret(secret);
    return keypair.publicKey();
  } catch {
    return null;
  }
}

function toStellarAsset(assetCode: string, assetIssuer: string): StellarSdk.Asset {
  return assetIssuer === "" || assetIssuer === "native"
    ? StellarSdk.Asset.native()
    : new StellarSdk.Asset(assetCode, assetIssuer);
}

function isNativeAsset(assetIssuer: string): boolean {
  return assetIssuer === "" || assetIssuer === "native";
}

class BalanceTracker {
  private state: BalanceTrackerState;
  private pollingIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;

  constructor(pollingIntervalMs: number = 30_000) {
    this.state = {
      balances: new Map(),
      hooks: [],
      triggerHooks: [],
    };
    this.pollingIntervalMs = pollingIntervalMs;
  }

  getBalances(): Map<string, BalanceSnapshot> {
    return this.state.balances;
  }

  getBalanceKey(
    accountPublicKey: string,
    asset: string,
    assetIssuer: string,
  ): string {
    return `${accountPublicKey}:${asset}:${assetIssuer}`;
  }

  onBalanceHook(hook: BalanceHook): () => void {
    this.state.hooks.push(hook);
    return () => {
      const idx = this.state.hooks.indexOf(hook);
      if (idx !== -1) this.state.hooks.splice(idx, 1);
    };
  }

  onRebalanceTriggerHook(hook: RebalanceTriggerHook): () => void {
    this.state.triggerHooks.push(hook);
    return () => {
      const idx = this.state.triggerHooks.indexOf(hook);
      if (idx !== -1) this.state.triggerHooks.splice(idx, 1);
    };
  }

  async trackBalance(
    accountPublicKey: string,
    asset: string,
    assetIssuer: string,
    fetchBalance: () => Promise<number>,
  ): Promise<BalanceSnapshot> {
    const key = this.getBalanceKey(accountPublicKey, asset, assetIssuer);
    const previous = this.state.balances.get(key) ?? null;
    const balance = await fetchBalance();
    const snapshot: BalanceSnapshot = {
      accountPublicKey,
      asset,
      assetIssuer,
      balance,
      timestamp: new Date(),
    };

    this.state.balances.set(key, snapshot);

    if (previous && previous.balance !== balance) {
      for (const hook of this.state.hooks) {
        try {
          hook(snapshot, previous);
        } catch (err) {
          logger.error(
            `[stellar-payments] BalanceHook error for ${key}:`,
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      }
    }

    return snapshot;
  }

  async trackAllOperatorBalances(
    asset: string,
    assetIssuer: string,
    fetchBalance: (
      accountPublicKey: string,
    ) => Promise<number>,
  ): Promise<BalanceSnapshot[]> {
    const snapshots = await Promise.all(
      Array.from(this.state.balances.values())
        .filter(
          (s) =>
            s.asset === asset && s.assetIssuer === assetIssuer,
        )
        .map(async (s) => ({
          ...s,
          balance: await fetchBalance(s.accountPublicKey),
          timestamp: new Date(),
        })),
    );

    for (const snapshot of snapshots) {
      const key = this.getBalanceKey(
        snapshot.accountPublicKey,
        snapshot.asset,
        snapshot.assetIssuer,
      );
      const previous = this.state.balances.get(key) ?? null;
      this.state.balances.set(key, snapshot);

      if (previous && previous.balance !== snapshot.balance) {
        this.fireBalanceHooks(snapshot, previous);
      }
    }

    return snapshots;
  }

  private fireBalanceHooks(
    snapshot: BalanceSnapshot,
    previous: BalanceSnapshot | null,
  ): void {
    for (const hook of this.state.hooks) {
      try {
        hook(snapshot, previous);
      } catch (err) {
        logger.error(
          `[stellar-payments] BalanceHook error for ${this.getBalanceKey(snapshot.accountPublicKey, snapshot.asset, snapshot.assetIssuer)}:`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }
  }

  async detectAndFireBreaches(
    snapshots: BalanceSnapshot[],
    floatLimits: FloatLimit[],
    checkFloatLimits: (
      balance: number,
      limit: FloatLimit,
    ) => "within" | "below_min" | "above_max",
  ): Promise<RebalanceTrigger[]> {
    const triggers: RebalanceTrigger[] = [];

    for (const snapshot of snapshots) {
      for (const limit of floatLimits) {
        if (snapshot.asset !== limit.asset) continue;
        if (snapshot.assetIssuer !== limit.assetIssuer) continue;

        const status = checkFloatLimits(snapshot.balance, limit);
        if (status === "within") continue;

        const trigger: RebalanceTrigger = {
          accountPublicKey: snapshot.accountPublicKey,
          asset: snapshot.asset,
          assetIssuer: snapshot.assetIssuer,
          currentBalance: snapshot.balance,
          limitType: status,
          deficitOrSurplus:
            status === "below_min"
              ? limit.minBalance - snapshot.balance
              : snapshot.balance - limit.maxBalance,
          targetBalance:
            status === "below_min" ? limit.minBalance : limit.maxBalance,
        };
        triggers.push(trigger);

        for (const hook of this.state.triggerHooks) {
          try {
            await hook(trigger);
          } catch (err) {
            logger.error(
              `[stellar-payments] RebalanceTriggerHook error for ${trigger.accountPublicKey}:`,
              err instanceof Error ? err : new Error(String(err)),
            );
          }
        }
      }
    }

    return triggers;
  }

  setBalance(
    accountPublicKey: string,
    asset: string,
    assetIssuer: string,
    balance: number,
  ): void {
    const key = this.getBalanceKey(accountPublicKey, asset, assetIssuer);
    const previous = this.state.balances.get(key) ?? null;
    const snapshot: BalanceSnapshot = {
      accountPublicKey,
      asset,
      assetIssuer,
      balance,
      timestamp: new Date(),
    };
    this.state.balances.set(key, snapshot);

    if (previous && previous.balance !== balance) {
      this.fireBalanceHooks(snapshot, previous);
    }
  }

  startPolling(
    fetchSnapshot: () => Promise<BalanceSnapshot[]>,
  ): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(async () => {
      try {
        await fetchSnapshot();
      } catch (err) {
        logger.error(
          `[stellar-payments] BalanceTracker polling error:`,
          err instanceof Error ? err : new Error(String(err)),
        );
      }
    }, this.pollingIntervalMs);
  }

  stopPolling(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

let globalBalanceTracker: BalanceTracker | null = null;

export function getBalanceTracker(): BalanceTracker {
  if (!globalBalanceTracker) {
    globalBalanceTracker = new BalanceTracker();
  }
  return globalBalanceTracker;
}

export function onBalanceHook(hook: BalanceHook): () => void {
  return getBalanceTracker().onBalanceHook(hook);
}

export function onRebalanceTriggerHook(
  hook: RebalanceTriggerHook,
): () => void {
  return getBalanceTracker().onRebalanceTriggerHook(hook);
}

export class RebalancePaymentService {
  private server: StellarSdk.Horizon.Server;
  private networkPassphrase: string;
  private assetService: AssetService;
  private operatorAccounts: OperatorAccount[];
  private floatLimits: FloatLimit[];
  private rebalanceSourcePublicKey: string | null;
  private rebalanceSourceKeypair: StellarSdk.Keypair | null;
  private balanceTracker: BalanceTracker;

  constructor() {
    this.server = getStellarServer();
    this.networkPassphrase = getNetworkPassphrase();
    this.assetService = new AssetService();
    this.operatorAccounts = getOperatorAccounts();
    this.floatLimits = getFloatLimits();
    this.rebalanceSourcePublicKey = getRebalanceSourceAccount();
    this.balanceTracker = getBalanceTracker();

    const secret = process.env.STELLAR_REBALANCE_SOURCE_SECRET?.trim();
    if (secret) {
      try {
        this.rebalanceSourceKeypair = StellarSdk.Keypair.fromSecret(secret);
      } catch {
        logger.warn(
          "[stellar-payments] STELLAR_REBALANCE_SOURCE_SECRET invalid",
        );
      }
    }
  }

  private logTransaction(
    entry: TransactionLogEntry,
  ): RebalancePaymentResult {
    const result: RebalancePaymentResult = {
      txHash: entry.txHash,
      ledger: entry.ledger,
      fromAccount: entry.fromAccount,
      toAccount: entry.toAccount,
      asset: entry.asset,
      assetIssuer: entry.assetIssuer,
      amount: entry.amount,
      status: entry.status,
      error: entry.error,
      loggedAt: new Date(),
    };

    const ctx = {
      txHash: entry.txHash,
      ledger: entry.ledger,
      from: entry.fromAccount,
      to: entry.toAccount,
      asset: entry.asset,
      assetIssuer: entry.assetIssuer,
      amount: entry.amount,
      status: entry.status,
      triggeredBy: entry.triggeredBy,
      durationMs: entry.durationMs,
    };

    if (entry.status === "success") {
      logger.info(
        `[stellar-payments] Transaction logged: ${JSON.stringify(ctx)}`,
      );
    } else if (entry.status === "failed") {
      logger.error(
        `[stellar-payments] Transaction logged (failed): ${JSON.stringify(ctx)} error=${entry.error ?? "unknown"}`,
      );
    } else {
      logger.warn(
        `[stellar-payments] Transaction logged (skipped): ${JSON.stringify(ctx)}`,
      );
    }

    return result;
  }

  async getOperatorBalance(
    accountPublicKey: string,
    asset: string,
    assetIssuer: string,
  ): Promise<number> {
    try {
      const account = await this.server.loadAccount(accountPublicKey);
      for (const balance of account.balances) {
        if (isNativeAsset(assetIssuer) && balance.asset_type === "native") {
          return parseFloat(balance.balance);
        }
        if (
          balance.asset_type !== "native" &&
          "asset_code" in balance &&
          (balance as StellarSdk.Horizon.HorizonApi.BalanceLineAsset).asset_code ===
            asset &&
          "asset_issuer" in balance &&
          (balance as StellarSdk.Horizon.HorizonApi.BalanceLineAsset).asset_issuer ===
            assetIssuer
        ) {
          return parseFloat(balance.balance);
        }
      }
      return 0;
    } catch (error) {
      logger.error(
        `[stellar-payments] Failed to fetch balance for ${accountPublicKey}:`,
        error,
      );
      return 0;
    }
  }

  async getAllOperatorBalances(
    asset: string,
    assetIssuer: string,
  ): Promise<BalanceSnapshot[]> {
    const snapshots = await Promise.all(
      this.operatorAccounts.map(async (account) => {
        const balance = await this.getOperatorBalance(
          account.publicKey,
          asset,
          assetIssuer,
        );
        this.balanceTracker.setBalance(
          account.publicKey,
          asset,
          assetIssuer,
          balance,
        );
        return {
          accountPublicKey: account.publicKey,
          asset,
          assetIssuer,
          balance,
          timestamp: new Date(),
        };
      }),
    );

    return snapshots;
  }

  checkFloatLimits(
    balance: number,
    limit: FloatLimit,
  ): "within" | "below_min" | "above_max" {
    if (balance < limit.minBalance) return "below_min";
    if (balance > limit.maxBalance) return "above_max";
    return "within";
  }

  detectBreaches(
    snapshots: BalanceSnapshot[],
  ): RebalanceTrigger[] {
    const triggers: RebalanceTrigger[] = [];
    for (const snapshot of snapshots) {
      for (const limit of this.floatLimits) {
        if (snapshot.asset !== limit.asset) continue;
        if (snapshot.assetIssuer !== limit.assetIssuer) continue;

        const status = this.checkFloatLimits(snapshot.balance, limit);
        if (status === "below_min") {
          triggers.push({
            accountPublicKey: snapshot.accountPublicKey,
            asset: snapshot.asset,
            assetIssuer: snapshot.assetIssuer,
            currentBalance: snapshot.balance,
            limitType: "below_min",
            deficitOrSurplus: limit.minBalance - snapshot.balance,
            targetBalance: limit.minBalance,
          });
        } else if (status === "above_max") {
          triggers.push({
            accountPublicKey: snapshot.accountPublicKey,
            asset: snapshot.asset,
            assetIssuer: snapshot.assetIssuer,
            currentBalance: snapshot.balance,
            limitType: "above_max",
            deficitOrSurplus: snapshot.balance - limit.maxBalance,
            targetBalance: limit.maxBalance,
          });
        }
      }
    }
    return triggers;
  }

  async initiateRebalancePayment(
    fromAccountPublicKey: string,
    toAccountPublicKey: string,
    asset: string,
    assetIssuer: string,
    amount: string,
    triggeredBy: "float_limit_breach" | "manual" | "scheduled" = "float_limit_breach",
  ): Promise<RebalancePaymentResult> {
    const startTime = Date.now();

    const logEntry: TransactionLogEntry = {
      txHash: null,
      ledger: null,
      fromAccount: fromAccountPublicKey,
      toAccount: toAccountPublicKey,
      asset,
      assetIssuer,
      amount,
      status: "failed",
      triggeredBy,
      timestamp: new Date(),
      processedAt: startTime,
      durationMs: 0,
    };

    if (!this.rebalanceSourceKeypair) {
      logEntry.error = "Rebalance source keypair not configured";
      logEntry.durationMs = Date.now() - startTime;
      return this.logTransaction(logEntry);
    }

    const stellarAsset = toStellarAsset(asset, assetIssuer);

    try {
      const fromAccount = await this.server.loadAccount(fromAccountPublicKey);

      const tx = new StellarSdk.TransactionBuilder(fromAccount, {
        fee: StellarSdk.BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          StellarSdk.Operation.payment({
            destination: toAccountPublicKey,
            asset: stellarAsset,
            amount,
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(this.rebalanceSourceKeypair);

      const response = await this.server.submitTransaction(tx);

      logEntry.txHash = response.hash;
      logEntry.ledger = response.ledger;
      logEntry.status = "success";
      logEntry.durationMs = Date.now() - startTime;

      return this.logTransaction(logEntry);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logEntry.error = errMsg;
      logEntry.status = "failed";
      logEntry.durationMs = Date.now() - startTime;

      return this.logTransaction(logEntry);
    }
  }

  async executeRebalance(
    trigger: RebalanceTrigger,
  ): Promise<RebalancePaymentResult> {
    const sourcePublicKey = this.rebalanceSourcePublicKey;
    if (!sourcePublicKey) {
      const result: RebalancePaymentResult = {
        txHash: null,
        ledger: null,
        fromAccount: trigger.accountPublicKey,
        toAccount: trigger.accountPublicKey,
        asset: trigger.asset,
        assetIssuer: trigger.assetIssuer,
        amount: "0",
        status: "failed",
        error: "Rebalance source account not configured",
        loggedAt: new Date(),
      };
      logger.error(
        `[stellar-payments] Cannot rebalance: source account not configured for trigger ${JSON.stringify(trigger)}`,
      );
      return result;
    }

    const amount = trigger.deficitOrSurplus.toFixed(7).replace(/\.?0+$/, "");

    let destinationPublicKey: string;
    if (trigger.limitType === "below_min") {
      destinationPublicKey = trigger.accountPublicKey;
    } else {
      destinationPublicKey = sourcePublicKey;
    }

    const result = await this.initiateRebalancePayment(
      sourcePublicKey,
      destinationPublicKey,
      trigger.asset,
      trigger.assetIssuer,
      amount,
      "float_limit_breach",
    );

    return result;
  }

  async runRebalanceCycle(): Promise<RebalancePaymentResult[]> {
    const results: RebalancePaymentResult[] = [];

    for (const limit of this.floatLimits) {
      const snapshots = await this.getAllOperatorBalances(
        limit.asset,
        limit.assetIssuer,
      );

      const triggers = await this.balanceTracker.detectAndFireBreaches(
        snapshots,
        this.floatLimits,
        (balance, fl) => this.checkFloatLimits(balance, fl),
      );

      for (const trigger of triggers) {
        const result = await this.executeRebalance(trigger);
        results.push(result);
      }
    }

    const successful = results.filter((r) => r.status === "success").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const skipped = results.filter((r) => r.status === "skipped").length;

    logger.info(
      `[stellar-payments] Rebalance cycle complete: successful=${successful} failed=${failed} skipped=${skipped} total=${results.length}`,
    );

    return results;
  }
}

let singleton: RebalancePaymentService | null = null;

export function getRebalancePaymentService(): RebalancePaymentService {
  if (!singleton) {
    singleton = new RebalancePaymentService();
  }
  return singleton;
}