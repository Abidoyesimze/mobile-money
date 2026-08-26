import logger from "../utils/logger";
import { Router, Response } from "express";
import { Transform } from "stream";
import { pipeline } from "stream/promises";
import PDFDocument from "pdfkit";
import { requireAuth, AuthRequest } from "../middleware/auth";

const ALLOWED_HEADERS = [
  "id",
  "user_id",
  "amount",
  "currency",
  "type",
  "status",
  "created_at",
  "description",
];

const PDF_COLUMN_LABELS: Record<string, string> = {
  id: "ID",
  user_id: "User",
  amount: "Amount",
  currency: "Currency",
  type: "Type",
  status: "Status",
  created_at: "Date",
  description: "Description",
};

interface TransactionExportFilters {
  startDate?: string;
  endDate?: string;
  status?: string;
  type?: string;
  fields?: string[];
  userId?: string;
}

function parseTransactionExportFilters(query: any): TransactionExportFilters {
  return {
    startDate: query.startDate,
    endDate: query.endDate,
    status: query.status,
    type: query.type,
    // userId is intentionally not read from the query string here — it is
    // always forced to the authenticated caller's own ID below, so a user
    // can never export another user's transactions by passing ?userId=...
    fields: query.fields
      ? String(query.fields)
          .split(",")
          .map((f) => f.trim())
      : undefined,
  };
}

function buildTransactionExportQuery(
  filters: TransactionExportFilters,
  exportHeaders: string[],
) {
  const conditions = [];
  const values = [];
  let paramCount = 1;

  if (filters.userId) {
    conditions.push(`user_id = $${paramCount++}`);
    values.push(filters.userId);
  }

  if (filters.startDate) {
    conditions.push(`created_at >= $${paramCount++}`);
    values.push(filters.startDate);
  }

  if (filters.endDate) {
    conditions.push(`created_at <= $${paramCount++}`);
    values.push(filters.endDate);
  }

  if (filters.status) {
    conditions.push(`status = $${paramCount++}`);
    values.push(filters.status);
  }

  if (filters.type) {
    conditions.push(`type = $${paramCount++}`);
    values.push(filters.type);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const selectFields = exportHeaders.join(", ");
  const text = `SELECT ${selectFields} FROM transactions ${whereClause} ORDER BY created_at DESC`;

  return { text, values };
}

function transactionRowToCsv(
  row: Record<string, unknown>,
  headers: string[],
): string {
  const values = headers.map((header) => {
    const value = row[header];
    if (value === null || value === undefined) return "";
    const stringValue = String(value);
    // Escape commas and quotes
    if (
      stringValue.includes(",") ||
      stringValue.includes('"') ||
      stringValue.includes("\n")
    ) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }
    return stringValue;
  });
  return values.join(",") + "\n";
}

/** Render a transaction row stream as a paginated PDF table, piped directly to `res`. */
async function streamPdfExport(
  rowStream: AsyncIterable<Record<string, unknown>>,
  headers: string[],
  res: Response,
): Promise<void> {
  const doc = new PDFDocument({ size: "A4", margin: 40, layout: "landscape" });
  doc.pipe(res);

  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;
  const margin = 40;
  const tableWidth = pageWidth - margin * 2;
  const colWidth = tableWidth / headers.length;

  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .text("Transaction Export", { align: "center" });
  doc
    .font("Helvetica")
    .fontSize(9)
    .fillColor("#666")
    .text(`Generated: ${new Date().toISOString()}`, { align: "center" });
  doc.moveDown(0.8);

  const drawHeaderRow = () => {
    const y = doc.y;
    doc
      .rect(margin, y, tableWidth, 18)
      .fillColor("#f0f0f0")
      .fill()
      .fillColor("#000000")
      .font("Helvetica-Bold")
      .fontSize(8);
    headers.forEach((header, i) => {
      doc.text(
        PDF_COLUMN_LABELS[header] ?? header,
        margin + i * colWidth + 2,
        y + 5,
        {
          width: colWidth - 4,
        },
      );
    });
    doc.y = y + 18;
    doc.font("Helvetica").fontSize(8).fillColor("#000000");
  };

  drawHeaderRow();

  let rowCount = 0;
  for await (const row of rowStream) {
    if (doc.y > pageHeight - 60) {
      doc.addPage();
      doc.moveDown(0.5);
      drawHeaderRow();
    }

    const y = doc.y;
    headers.forEach((header, i) => {
      const value = row[header];
      const text = value === null || value === undefined ? "" : String(value);
      doc.text(text, margin + i * colWidth + 2, y + 4, {
        width: colWidth - 4,
      });
    });
    doc.y = y + 16;
    rowCount++;
  }

  if (rowCount === 0) {
    doc.moveDown(0.5).fillColor("#999").text("No transactions found.");
  }

  doc.end();
}

export function createExportRoutes(options?: {
  db?: any;
  createQueryStream?: any;
}) {
  const db = options?.db || require("../config/database").pool;
  const createQueryStream =
    options?.createQueryStream || require("pg-query-stream");

  const router = Router();

  router.get(
    "/export",
    requireAuth,
    async (req: AuthRequest, res: Response) => {
      let client: any;
      let clientReleased = false;
      let releaseClient = () => {
        if (!clientReleased && client) {
          client.release();
          clientReleased = true;
        }
      };

      try {
        if (!req.user?.id) {
          return res.status(401).json({ error: "Unauthorized" });
        }

        const filters = parseTransactionExportFilters(req.query);
        // Always scope to the authenticated caller — never trust a
        // client-supplied userId, otherwise any user could export another
        // user's transactions by guessing their ID.
        filters.userId = req.user.id;

        const requestedFields = filters.fields?.filter((f: string) =>
          ALLOWED_HEADERS.includes(f),
        );
        const exportHeaders =
          requestedFields && requestedFields.length > 0
            ? requestedFields
            : ALLOWED_HEADERS;

        const { text, values } = buildTransactionExportQuery(
          filters,
          exportHeaders,
        );

        client = await db.connect();
        releaseClient = () => client.release();
        const queryStream = createQueryStream(text, values);
        const rowStream = client.query(queryStream);

        const format = ["json", "pdf"].includes(req.query.format as string)
          ? (req.query.format as "json" | "pdf")
          : "csv";
        const filename = `transactions-${new Date().toISOString().slice(0, 10)}.${format}`;

        res.status(200);
        res.setHeader(
          "Content-Type",
          format === "json"
            ? "application/json"
            : format === "pdf"
              ? "application/pdf"
              : "text/csv; charset=utf-8",
        );
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="${filename}"`,
        );

        res.on("close", () => {
          if (
            "destroy" in rowStream &&
            typeof rowStream.destroy === "function"
          ) {
            rowStream.destroy();
          }
          releaseClient();
        });

        if (format === "pdf") {
          await streamPdfExport(rowStream, exportHeaders, res);
          releaseClient();
          return;
        }

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
              const data =
                (first ? "" : ",\n") + JSON.stringify(chunk, null, 2);
              first = false;
              callback(null, data);
            },
            flush(callback) {
              res.write("\n]");
              callback();
            },
          });
        }

        await pipeline(rowStream, transform, res);
      } catch (error) {
        logger.error("Transaction export failed:", error);
        releaseClient();
        if (!res.headersSent) {
          res.status(500).json({ error: "Export failed" });
        }
      }
    },
  );

  return router;
}
