  // Worker Concurrency Configuration
  worker: {
    concurrency: {
      doc: "Transaction processing worker concurrency limit",
      format: "nat",
      default: 50,
      env: "TRANSACTION_WORKER_CONCURRENCY",
    },
    syncConcurrency: {
      doc: "Accounting sync worker concurrency limit",
      format: "nat",
      default: 20,
      env: "SYNC_WORKER_CONCURRENCY",
    },
    webhookRetryConcurrency: {
      doc: "Webhook retry worker concurrency limit",
      format: "nat",
      default: 10,
      env: "WEBHOOK_RETRY_WORKER_CONCURRENCY",
    },
    accountingRetryConcurrency: {
      doc: "Accounting retry worker concurrency limit",
      format: "nat",
      default: 5,
      env: "ACCOUNTING_RETRY_WORKER_CONCURRENCY",
    },
    accountingTokenRefreshConcurrency: {
      doc: "Accounting token refresh worker concurrency limit",
      format: "nat",
      default: 3,
      env: "ACCOUNTING_TOKEN_REFRESH_WORKER_CONCURRENCY",
    },
    providerBalanceAlertConcurrency: {
      doc: "Provider balance alert worker concurrency limit (default 1 – sequential to prevent duplicate alerts)",
      format: "nat",
      default: 1,
      env: "PROVIDER_BALANCE_ALERT_WORKER_CONCURRENCY",
    },
  },

  // Cross-origin request settings
  cors: {
    allowedOrigins: {
      doc: "List of allowed CORS origins loaded from config files",
      format: Array,
      default: ["http://localhost:3000"],
      env: "CORS_ALLOWED_ORIGINS",
    },
  },