import logger from "../utils/logger";
import { Router, Request, Response } from "express";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import {
  DEFAULT_ALLOWED_HEADERS,
  EXTENDED_ALLOWED_HEADERS,
  parseTransactionExportFilters as parseFiltersUtil,
  buildTransactionExportQuery as buildQueryUtil,
  transactionRowToCsv as rowToCsvUtil,
  TransactionExportFilters,
  RawExportQuery,
} from "../utils/csvExporter";
import rateLimit from "express-rate-limit";
import { NextFunction, RequestHandler } from "express";

export const ALLOWED_HEADERS = [
  ...DEFAULT_ALLOWED_HEADERS,
  ...EXTENDED_ALLOWED_HEADERS.filter(
    (h) => !DEFAULT_ALLOWED_HEADERS.includes(h),
  ),
];

export const ADMIN_DISPLAY_HEADERS = [
  "ID",
  "Reference Number",
  "Type",
  "Amount",
  "Phone Number",
  "Provider",
  "Status",
  "Stellar Address",
  "Tags",
  "Notes",
  "Admin Notes",
  "User ID",
  "Created At",
  "Updated At",
];

export function parseTransactionExportFilters(
  query: RawExportQuery,
): TransactionExportFilters {
  return parseFiltersUtil(query);
}

export function buildTransactionExportQuery(
  filters: TransactionExportFilters,
  exportHeaders?: string[],
) {
  return buildQueryUtil(filters, exportHeaders);
}

export function transactionRowToCsv(
  row: Record<string, unknown>,
  headers: string[],
): string {
  return rowToCsvUtil(row, headers);
}

function getScopedUserId(req: Request): string | null {
  return (req as Request & { user?: { id?: string } }).user?.id || null;
}

export const exportRateLimiter =
  process.env.NODE_ENV === "test"
    ? (_req: Request, _res: Response, next: NextFunction) => next()
    : rateLimit({
        windowMs: 60 * 60 * 1000,
        max: 30,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: "Too many export requests, please try again later." },
      });

export interface ExportRouteOptions {
  db?: {
    connect: () => Promise<{
      query: (q: unknown) => unknown;
      release: () => void;
    }>;
  };
  createQueryStream?: (text: string, values: unknown[]) => unknown;
  rateLimiter?: RequestHandler;
}

export function createExportRoutes(options?: ExportRouteOptions) {
  const db = options?.db || require("../config/database").pool;
  const createQueryStream =
    options?.createQueryStream || require("pg-query-stream");

  const router = Router();
  const limiter = options?.rateLimiter || exportRateLimiter;

  router.get("/export", limiter, async (req: Request, res: Response) => {
    // Admin API Key verification if configured and mounted on admin path
    const adminKey = process.env.ADMIN_API_KEY;
    const reqApiKey =
      (req.headers["x-api-key"] as string) ||
      (req.headers["x-admin-key"] as string);
    const hasUser = !!(req as Request & { user?: unknown }).user;
    const isAdminRoute =
      (req.baseUrl || "").includes("/api/transactions") ||
      (req.originalUrl || "").includes("/api/transactions");

    if (isAdminRoute && adminKey && !hasUser && reqApiKey !== adminKey) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    let client:
      { query: (q: unknown) => unknown; release: () => void } | undefined;
    let clientReleased = false;
    let releaseClient = () => {
      if (!clientReleased && client) {
        client.release();
        clientReleased = true;
      }
    };

    try {
      const filters = parseTransactionExportFilters(req.query);
      const scopedUserId = getScopedUserId(req);

      if (scopedUserId) {
        filters.userId = scopedUserId;
      }

      let exportHeaders: string[];
      if (filters.fields && filters.fields.length > 0) {
        exportHeaders = filters.fields.filter(
          (f: string) =>
            ALLOWED_HEADERS.includes(f.toLowerCase()) ||
            ADMIN_DISPLAY_HEADERS.map((h) => h.toLowerCase()).includes(
              f.toLowerCase(),
            ),
        );
        if (exportHeaders.length === 0) {
          exportHeaders = DEFAULT_ALLOWED_HEADERS;
        }
      } else if (reqApiKey && reqApiKey === adminKey) {
        exportHeaders = ADMIN_DISPLAY_HEADERS;
      } else {
        exportHeaders = DEFAULT_ALLOWED_HEADERS;
      }

      const { text, values } = buildTransactionExportQuery(
        filters,
        exportHeaders,
      );

      client = await db.connect();
      releaseClient = () => {
        if (!clientReleased && client) {
          client.release();
          clientReleased = true;
        }
      };

      const queryStream = createQueryStream(text, values);
      const rowStream = client.query(queryStream) as NodeJS.ReadableStream;

      const format = req.query.format === "json" ? "json" : "csv";
      const filename = `transactions-${new Date().toISOString().slice(0, 10)}.${format}`;

      res.status(200);
      res.setHeader(
        "Content-Type",
        format === "json" ? "application/json" : "text/csv; charset=utf-8",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );

      let transform: Transform;

      if (format === "csv") {
        res.write(`\uFEFF${exportHeaders.join(",")}\n`);
        transform = new Transform({
          objectMode: true,
          transform(chunk: Record<string, unknown>, _encoding, callback) {
            callback(null, transactionRowToCsv(chunk, exportHeaders));
          },
        });
      } else {
        let first = true;
        res.write("[\n");
        transform = new Transform({
          objectMode: true,
          transform(chunk: Record<string, unknown>, _encoding, callback) {
            const data = (first ? "" : ",\n") + JSON.stringify(chunk, null, 2);
            first = false;
            callback(null, data);
          },
          flush(callback) {
            res.write("\n]");
            callback();
          },
        });
      }

      res.on("close", () => {
        if ("destroy" in rowStream && typeof rowStream.destroy === "function") {
          rowStream.destroy();
        }
        releaseClient();
      });

      await pipeline(rowStream, transform, res);
    } catch (error) {
      logger.error("Transaction export failed:", error);
      releaseClient();
      if (!res.headersSent) {
        res.status(500).json({ error: "Export failed" });
      }
    }
  });

  return router;
}
