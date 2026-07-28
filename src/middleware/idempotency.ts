import { Request, Response, NextFunction } from "express";
import { queryWrite, queryRead, getPoolClient } from "../config/database";
import logger from "../utils/logger";
import crypto from "crypto";

// Ensure idempotency table exists
async function ensureIdempotencyTable() {
  await queryWrite(`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key VARCHAR(255) PRIMARY KEY,
      status VARCHAR(50) NOT NULL,
      response_status INTEGER,
      response_body JSONB,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `, []);
}

// Ensure table exists on load
ensureIdempotencyTable().catch(err => logger.error("Failed to ensure idempotency table", err));

export async function idempotency(req: Request, res: Response, next: NextFunction) {
  const key = req.headers["idempotency-key"] as string;
  if (!key) {
    return next();
  }

  // Generate a numeric hash for the advisory lock to prevent race conditions during insertion
  const hash = crypto.createHash("md5").update(key).digest("hex");
  const lockId = parseInt(hash.substring(0, 8), 16);

  const client = await getPoolClient();
  try {
    // 1. Check Transaction Locks on request starts
    const lockResult = await client.query("SELECT pg_try_advisory_lock($1) as locked", [lockId]);
    const locked = lockResult.rows[0].locked;

    if (!locked) {
      return res.status(409).json({ error: "Concurrent request in progress for this idempotency key" });
    }

    // 2. Check if key already exists
    const recordResult = await client.query("SELECT * FROM idempotency_keys WHERE key = $1", [key]);
    if (recordResult.rows.length > 0) {
      const record = recordResult.rows[0];
      // 3. Duplicate execution requests return original result
      if (record.status === "completed") {
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
        client.release();
        return res.status(record.response_status).json(record.response_body);
      } else if (record.status === "processing") {
        await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
        client.release();
        return res.status(409).json({ error: "Request currently processing" });
      }
    } else {
      await client.query(
        "INSERT INTO idempotency_keys (key, status) VALUES ($1, 'processing')",
        [key]
      );
    }

    // Wrap the response to capture finalization state
    const originalSend = res.send.bind(res);
    res.send = (body: any) => {
      // 2. Release locks only on request finalization states (by storing response and unlocking)
      let parsedBody = body;
      try {
        parsedBody = typeof body === "string" ? JSON.parse(body) : body;
      } catch (e) {
        parsedBody = { data: body };
      }

      client.query(
        "UPDATE idempotency_keys SET status = 'completed', response_status = $1, response_body = $2, updated_at = CURRENT_TIMESTAMP WHERE key = $3",
        [res.statusCode, JSON.stringify(parsedBody), key]
      ).finally(() => {
        client.query("SELECT pg_advisory_unlock($1)", [lockId]).finally(() => {
          client.release();
        });
      });

      return originalSend(body);
    };

    next();
  } catch (error) {
    await client.query("SELECT pg_advisory_unlock($1)", [lockId]);
    client.release();
    next(error);
  }
}
