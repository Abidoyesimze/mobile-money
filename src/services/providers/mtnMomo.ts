/**
 * MTN MoMo reconciliation adapter.
 *
 * Thin wrapper around the MTNProvider that exposes helpers specifically
 * for the transaction-status reconciliation flow:
 *  - fetchPendingTransactions  — queries the database for pending MTN records
 *  - queryProviderStatus       — queries the MTN operator for a single reference
 *  - reconcilePendingTransactions — orchestrates the full reconciliation pass
 */

import { queryRead, queryWrite } from "../../config/database";
import { TransactionStatus } from "../../models/transaction";
import { MTNProvider } from "../mobilemoney/providers/mtn";
import logger from "../../utils/logger";

export interface PendingTransaction {
  id: string;
  referenceNumber: string;
  providerReference: string | null;
  phoneNumber: string;
  amount: string;
  status: TransactionStatus;
  createdAt: Date;
}

export interface ReconcileResult {
  id: string;
  referenceNumber: string;
  previousStatus: TransactionStatus;
  newStatus: TransactionStatus | null;
  updated: boolean;
  providerStatus: string;
}

/**
 * Fetch all MTN transactions currently in `pending` status.
 */
export async function fetchPendingTransactions(): Promise<
  PendingTransaction[]
> {
  const result = await queryRead(
    `SELECT
       id,
       reference_number         AS "referenceNumber",
       provider_reference       AS "providerReference",
       phone_number             AS "phoneNumber",
       amount::text             AS amount,
       status,
       created_at               AS "createdAt"
     FROM transactions
     WHERE status = $1
       AND provider ILIKE 'mtn%'
     ORDER BY created_at ASC`,
    [TransactionStatus.Pending],
  );
  return result.rows as PendingTransaction[];
}

/**
 * Map an MTN provider status string to a local TransactionStatus.
 * Returns null when the provider reports the transaction is still pending
 * (no update needed).
 */
function mapProviderStatus(
  providerStatus: string,
): TransactionStatus | null {
  switch (providerStatus) {
    case "completed":
      return TransactionStatus.Completed;
    case "failed":
      return TransactionStatus.Failed;
    case "pending":
      return null; // still in-flight — leave as-is
    default:
      return null; // unknown — do not overwrite
  }
}

/**
 * Query the MTN operator for a single transaction reference and update the
 * local record when a terminal status is found.
 */
async function reconcileOne(
  provider: MTNProvider,
  tx: PendingTransaction,
): Promise<ReconcileResult> {
  // Prefer providerReference; fall back to referenceNumber for legacy rows.
  const referenceId = tx.providerReference ?? tx.referenceNumber;

  let providerStatus = "unknown";
  try {
    const result = await provider.getTransactionStatus(referenceId);
    providerStatus = result.status;
  } catch (err) {
    logger.warn(
      { err, txId: tx.id, referenceId },
      "mtnMomo reconcile: failed to query provider status",
    );
  }

  const newStatus = mapProviderStatus(providerStatus);

  if (!newStatus || newStatus === tx.status) {
    return {
      id: tx.id,
      referenceNumber: tx.referenceNumber,
      previousStatus: tx.status,
      newStatus: null,
      updated: false,
      providerStatus,
    };
  }

  await queryWrite(
    `UPDATE transactions
        SET status     = $1,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $2`,
    [newStatus, tx.id],
  );

  logger.info(
    { txId: tx.id, referenceNumber: tx.referenceNumber, newStatus },
    "mtnMomo reconcile: status updated",
  );

  return {
    id: tx.id,
    referenceNumber: tx.referenceNumber,
    previousStatus: tx.status,
    newStatus,
    updated: true,
    providerStatus,
  };
}

/**
 * Run a full reconciliation pass for all pending MTN transactions.
 *
 * Iterates over every pending transaction, queries the MTN operator log,
 * and persists any status change directly to the database.
 */
export async function reconcilePendingTransactions(): Promise<{
  total: number;
  updated: number;
  results: ReconcileResult[];
}> {
  const provider = new MTNProvider();
  const pending = await fetchPendingTransactions();

  logger.info(
    { count: pending.length },
    "mtnMomo reconcile: starting pass",
  );

  const results: ReconcileResult[] = [];
  for (const tx of pending) {
    const result = await reconcileOne(provider, tx);
    results.push(result);
  }

  const updated = results.filter((r) => r.updated).length;

  logger.info(
    { total: pending.length, updated },
    "mtnMomo reconcile: pass complete",
  );

  return { total: pending.length, updated, results };
}
