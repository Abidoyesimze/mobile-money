import logger from "../utils/logger";
import tracer from "../tracer";
import { Worker, Job } from "bullmq";
import { queueOptions, getTelecomProviderLimits } from "./config";
import { SyncJobData, SyncJobResult, SYNC_QUEUE_NAME } from "./syncQueue";
import {
  AccountingService,
  RateLimitError,
  NetworkError,
  ValidationError,
} from "../services/accounting/accountingService";
import { pool } from "../config/database";
import { addAccountingRetryJob } from "./accountingRetryQueue";
import { natsManager, NATS_QUEUE_ENABLED, type JsMsg } from "./nats";
import { amlService, AMLTransactionRecord } from "../services/aml";

const getSyncConcurrency = (): number => {
  const envVal = process.env.SYNC_WORKER_CONCURRENCY;
  if (envVal === undefined || envVal === "") return 3;
  const parsed = parseInt(envVal, 10);
  if (isNaN(parsed)) return 3;
  return parsed < 1 ? 1 : parsed;
};

export const SYNC_CONCURRENCY = getSyncConcurrency();
export const NATS_SYNC_SUBJECT = process.env.NATS_SYNC_SUBJECT || "accounting.sync";
export const NATS_SYNC_DURABLE_CONSUMER =
  process.env.NATS_SYNC_DURABLE_CONSUMER || "accounting-sync-consumer";
export const NATS_SYNC_CONSUMER_GROUP =
  process.env.NATS_SYNC_CONSUMER_GROUP ||
  process.env.NATS_CONSUMER_GROUP ||
  "accounting-sync-group";

type DatadogSpan = ReturnType<typeof tracer.startSpan>;

function tagSyncSpan(
  span: DatadogSpan,
  data: Pick<SyncJobData, "syncId" | "transactionId" | "platform">,
  source: "bullmq" | "nats",
): void {
  span.setTag("service.name", process.env.DD_SERVICE || "mobile-money");
  span.setTag("span.type", "worker");
  span.setTag("component", "transaction-sync-queue");
  span.setTag("queue.name", SYNC_QUEUE_NAME);
  span.setTag("queue.source", source);
  span.setTag("sync.id", data.syncId);
  span.setTag("transaction.id", data.transactionId);
  span.setTag("accounting.platform", data.platform);
}

function spanLogFields(span: DatadogSpan): Record<string, unknown> {
  const context = span.context() as {
    toTraceId?: () => string;
    toSpanId?: () => string;
  };
  const traceId = context.toTraceId?.();
  const spanId = context.toSpanId?.();

  if (!traceId && !spanId) {
    return {};
  }

  return {
    dd: {
      trace_id: traceId,
      span_id: spanId,
    },
  };
}

function finishSyncSpan(
  span: DatadogSpan,
  startedAt: number,
  status: "success" | "failed",
): number {
  const latencyMs = Date.now() - startedAt;
  span.setTag("queue.request_latency_ms", latencyMs);
  span.setTag("queue.result", status);
  span.finish();
  return latencyMs;
}

async function runWithinSpan<T>(
  span: DatadogSpan,
  work: () => Promise<T>,
): Promise<T> {
  return tracer.scope().activate(span, work);
}

// Create instance of our Accounting Service
export const accountingService = new AccountingService();

// ---------------------------------------------------------------------------
// Core processing logic (shared by both BullMQ and NATS paths)
// ---------------------------------------------------------------------------

/**
 * Log accounting sync error to dedicated table
 */
async function logAccountingSyncError(
  transactionId: string,
  providerType: "quickbooks" | "xero",
  errorMessage: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO accounting_sync_errors
       (transaction_id, provider_type, error_message, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT DO NOTHING`,
    [transactionId, providerType, errorMessage.slice(0, 500)],
  );
}

/**
 * Evaluates AML compliance and suspicious structuring patterns for synced transactions
 */
export async function checkSyncTransactionCompliance(
  transactionId: string,
  amountStr?: string,
): Promise<void> {
  try {
    const query = `SELECT user_id AS "userId", type, amount, created_at AS "createdAt" FROM transactions WHERE id = $1`;
    const result = await pool.query<{
      userId: string;
      type: "deposit" | "withdraw";
      amount: number;
      createdAt: Date;
    }>(query, [transactionId]);

    if (result.rows.length > 0) {
      const row = result.rows[0];
      const record: AMLTransactionRecord = {
        id: transactionId,
        userId: row.userId,
        type: row.type || "deposit",
        amount: Number(amountStr ?? row.amount),
        createdAt: row.createdAt ? new Date(row.createdAt) : new Date(),
      };
      const amlResult = await amlService.monitorTransaction(record);
      if (amlResult.flagged) {
        logger.warn(
          {
            transactionId,
            userId: row.userId,
            reasons: amlResult.reasons,
            ruleHits: amlResult.ruleHits,
          },
          "[SyncWorker] Suspicious transaction / structuring alert triggered during sync",
        );
      }
    }
  } catch (err) {
    logger.error(
      { transactionId, err },
      "[SyncWorker] Failed to evaluate AML compliance on sync transaction",
    );
  }
}

/**
 * Sync Queue Processor Function
 * Handles the execution logic for a sync job, distinguishing transient and permanent errors.
 * On permanent failure after max retries, moves job to accounting retry queue for manual/scheduled retry.
 */
export async function processSyncJob(
  job: Job<SyncJobData, SyncJobResult>,
): Promise<SyncJobResult> {
  const { syncId, transactionId, platform, payload } = job.data;
  const span = tracer.startSpan("mobile_money.queue.sync.process");
  const logFields = spanLogFields(span);
  const startedAt = Date.now();
  let spanStatus: "success" | "failed" = "failed";

  tagSyncSpan(span, job.data, "bullmq");

  logger.info(
    {
      ...logFields,
      queueName: SYNC_QUEUE_NAME,
      queueSource: "bullmq",
      jobId: job.id,
      syncId,
      transactionId,
      platform,
      attempt: job.attemptsMade + 1,
    },
    "Processing accounting sync operation",
  );

  try {
    // Scan transaction for suspicious structuring / AML alert triggers
    await runWithinSpan(span, () =>
      checkSyncTransactionCompliance(transactionId, payload?.amount),
    );

    if (platform === "quickbooks") {
      await runWithinSpan(span, () =>
        accountingService.syncToQuickBooks(transactionId, payload),
      );
    } else if (platform === "xero") {
      await runWithinSpan(span, () =>
        accountingService.syncToXero(transactionId, payload),
      );
    } else {
      throw new ValidationError(`Unsupported accounting platform: ${platform}`);
    }

    spanStatus = "success";
    const latencyMs = Date.now() - startedAt;
    span.setTag("queue.request_latency_ms", latencyMs);

    logger.info(
      {
        ...logFields,
        queueName: SYNC_QUEUE_NAME,
        queueSource: "bullmq",
        latencyMs,
        jobId: job.id,
        syncId,
        transactionId,
        platform,
      },
      "Successfully synced transaction to accounting platform",
    );

    return { success: true, syncId, platform };
  } catch (error: unknown) {
    span.setTag("error", error);
    const isTransient =
      error instanceof RateLimitError || error instanceof NetworkError;
    const message = error instanceof Error ? error.message : String(error);
    const maxAttempts = job.opts.attempts || 5;
    const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;
    const latencyMs = Date.now() - startedAt;

    if (isTransient) {
      logger.warn(
        {
          ...logFields,
          queueName: SYNC_QUEUE_NAME,
          queueSource: "bullmq",
          latencyMs,
          jobId: job.id,
          syncId,
          transactionId,
          platform,
          attempt: job.attemptsMade + 1,
          maxAttempts,
          error: message,
          isTransient: true,
        },
        "Transient error during accounting sync - will retry with backoff",
      );
      
      // Dynamic Throttling: If external API hits a rate limit, safely delay worker processing natively
      if (error instanceof RateLimitError) {
        throw Worker.RateLimitError(); // 5 second cool-down period
      }

      throw error;
    } else {
      // Permanent error (e.g. ValidationError)
      logger.error(
        {
          ...logFields,
          queueName: SYNC_QUEUE_NAME,
          queueSource: "bullmq",
          latencyMs,
          jobId: job.id,
          syncId,
          transactionId,
          platform,
          attempt: job.attemptsMade + 1,
          maxAttempts,
          error: message,
          isPermanent: true,
        },
        "Permanent error during accounting sync - moving to retry queue",
      );
      await logAccountingSyncError(transactionId, platform, message);

      // Move failed job to accounting retry queue for manual/scheduled retry
      if (isLastAttempt) {
        try {
          await addAccountingRetryJob(
            {
              originalJobId: job.id ?? "",
              syncId,
              transactionId,
              platform,
              payload,
              failureReason: message,
              previousAttempts: job.attemptsMade + 1,
              failedAt: new Date().toISOString(),
            },
            {
              delay: 60000, // Delay retry by 1 minute to allow investigation
            },
          );

          logger.info(
            {
              jobId: job.id,
              syncId,
              transactionId,
              platform,
            },
            "Moved failed accounting sync to retry queue",
          );
        } catch (queueErr) {
          logger.error(
            {
              jobId: job.id,
              syncId,
              queueError:
                queueErr instanceof Error ? queueErr.message : String(queueErr),
            },
            "Failed to add accounting sync to retry queue",
          );
        }
      }

      try {
        await job.discard();
      } catch (discardErr) {
        logger.error(
          {
            jobId: job.id,
            discardError:
              discardErr instanceof Error
                ? discardErr.message
                : String(discardErr),
          },
          "Failed to discard sync job",
        );
      }

      throw error;
    }
  } finally {
    finishSyncSpan(span, startedAt, spanStatus);
  }
}

/**
 * Processes a raw SyncJobData payload received from NATS.
 * Returns true on success, throws on transient errors (triggering a nak),
 * and swallows permanent errors after logging (triggering an ack to avoid
 * infinite redelivery of unprocessable messages).
 */
async function processNatsSyncMessage(
  data: SyncJobData,
  msg: JsMsg,
): Promise<void> {
  const { syncId, transactionId, platform } = data;
  const span = tracer.startSpan("mobile_money.queue.sync.nats.process");
  const logFields = spanLogFields(span);
  const startedAt = Date.now();
  let spanStatus: "success" | "failed" = "failed";

  tagSyncSpan(span, data, "nats");

  logger.info(
    {
      ...logFields,
      queueName: SYNC_QUEUE_NAME,
      queueSource: "nats",
      syncId,
      transactionId,
      platform,
    },
    "[SyncWorker] [NATS] Processing accounting sync operation",
  );

  try {
    await runWithinSpan(span, () =>
      checkSyncTransactionCompliance(transactionId, data.payload?.amount),
    );

    if (platform === "quickbooks") {
      await runWithinSpan(span, () =>
        accountingService.syncToQuickBooks(transactionId, data.payload),
      );
    } else if (platform === "xero") {
      await runWithinSpan(span, () =>
        accountingService.syncToXero(transactionId, data.payload),
      );
    } else {
      // Permanent — term the message so it is never redelivered
      span.setTag("error", true);
      logger.error(
        {
          ...logFields,
          queueName: SYNC_QUEUE_NAME,
          queueSource: "nats",
          syncId,
          transactionId,
          platform,
        },
        "[SyncWorker] [NATS] Unsupported accounting platform. Terminating message.",
      );
      msg.term();
      return;
    }

    spanStatus = "success";
    const latencyMs = Date.now() - startedAt;
    span.setTag("queue.request_latency_ms", latencyMs);

    logger.info(
      {
        ...logFields,
        queueName: SYNC_QUEUE_NAME,
        queueSource: "nats",
        latencyMs,
        syncId,
        transactionId,
        platform,
      },
      "[SyncWorker] [NATS] Successfully synced transaction to accounting platform.",
    );
    // natsManager.consume acks on success; nothing extra needed here
  } catch (error: unknown) {
    span.setTag("error", error);
    const isTransient =
      error instanceof RateLimitError || error instanceof NetworkError;
    const message = error instanceof Error ? error.message : String(error);
    const latencyMs = Date.now() - startedAt;

    if (isTransient) {
      // Re-throw so natsManager.consume issues a nak and JetStream redelivers
      logger.warn(
        {
          ...logFields,
          queueName: SYNC_QUEUE_NAME,
          queueSource: "nats",
          latencyMs,
          syncId,
          transactionId,
          platform,
          error: message,
          isTransient: true,
        },
        "[SyncWorker] [NATS] Transient error during accounting sync - will nak for redelivery",
      );
      throw error;
    } else {
      // Permanent error — term to avoid infinite redelivery loop
      logger.error(
        {
          ...logFields,
          queueName: SYNC_QUEUE_NAME,
          queueSource: "nats",
          latencyMs,
          syncId,
          transactionId,
          platform,
          error: message,
          isPermanent: true,
        },
        "[SyncWorker] [NATS] Permanent error during accounting sync - terminating message",
      );
      msg.term();
    }
  } finally {
    finishSyncSpan(span, startedAt, spanStatus);
  }
}

// ---------------------------------------------------------------------------
// BullMQ Worker (active when NATS_QUEUE_ENABLED !== "true")
// ---------------------------------------------------------------------------

// Fetch limits specifically matched to the active telecom/provider 
const providerLimits = getTelecomProviderLimits(process.env.ACTIVE_PROVIDER);
const resolvedConcurrency = process.env.SYNC_WORKER_CONCURRENCY 
  ? SYNC_CONCURRENCY 
  : providerLimits.concurrency;

// Instantiate the BullMQ Worker dynamically restricted to provider API boundaries
export const syncWorker = new Worker<SyncJobData, SyncJobResult>(
  SYNC_QUEUE_NAME,
  processSyncJob,
  {
    ...queueOptions,
    concurrency: resolvedConcurrency, // Dynamic concurrency limit set via telecom configs
    limiter: providerLimits.limiter,  // Ensures execution strictly matches provider speed boundaries
  },
);

// ---------------------------------------------------------------------------
// NATS JetStream Consumer (active when NATS_QUEUE_ENABLED === "true")
//
// All instances sharing NATS_SYNC_CONSUMER_GROUP form a competing-consumer
// group.  JetStream delivers each message to exactly one group member,
// providing automatic load-balancing across horizontally-scaled workers
// without duplicate processing.
// ---------------------------------------------------------------------------

if (NATS_QUEUE_ENABLED) {
  natsManager
    .consume<SyncJobData>(
      NATS_SYNC_SUBJECT,
      NATS_SYNC_DURABLE_CONSUMER,
      NATS_SYNC_CONSUMER_GROUP,
      processNatsSyncMessage,
      resolvedConcurrency, // Synchronize NATS concurrency with telecom limits 
    )
    .catch((err) =>
      console.error("[SyncWorker] [NATS] JetStream consumer error:", err),
    );
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export async function closeSyncWorker(): Promise<void> {
  await syncWorker.close();
  if (NATS_QUEUE_ENABLED) {
    await natsManager.close();
  }
}