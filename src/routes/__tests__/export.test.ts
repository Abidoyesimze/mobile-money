import express from "express";
import request from "supertest";
import { PassThrough } from "stream";

jest.mock("../../middleware/auth", () => ({
  requireAuth: jest.fn((req, res, next) => {
    const userId = req.headers["x-test-user-id"];
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    req.user = { id: userId };
    next();
  }),
}));

import { createExportRoutes } from "../export";

function buildApp(
  rows: Record<string, unknown>[],
  createQueryStream = jest.fn(
    (text: string, values: unknown[]) => ({ text, values }) as any,
  ),
) {
  const stream = new PassThrough({ objectMode: true });
  const client = {
    release: jest.fn(),
    query: jest.fn(() => {
      process.nextTick(() => {
        rows.forEach((row) => stream.write(row));
        stream.end();
      });
      return stream;
    }),
  };

  const db = { connect: jest.fn().mockResolvedValue(client) };

  const app = express();
  app.use(
    createExportRoutes({
      db: db as any,
      createQueryStream: createQueryStream as any,
    }),
  );

  return { app, db, client, createQueryStream };
}

describe("createExportRoutes", () => {
  describe("authentication and scoping", () => {
    it("rejects unauthenticated requests with 401", async () => {
      const { app } = buildApp([]);

      await request(app).get("/export").expect(401);
    });

    it("always scopes the query to the authenticated caller, ignoring a client-supplied userId", async () => {
      const { app, createQueryStream } = buildApp([]);

      await request(app)
        .get("/export?userId=someone-elses-id&format=json")
        .set("x-test-user-id", "user-1")
        .expect(200);

      expect(createQueryStream).toHaveBeenCalledWith(
        expect.stringContaining("WHERE"),
        ["user-1"],
      );
    });
  });

  describe("CSV export", () => {
    it("streams CSV exports with scoped filters and escaped values", async () => {
      const rows = [
        {
          id: 1,
          user_id: "user-1",
          amount: 100,
          currency: "USD",
          type: "deposit",
          status: "completed",
          created_at: "2024-01-02T03:04:05.000Z",
          description: 'hello,"world"\nnext',
        },
      ];
      const { app, client, createQueryStream } = buildApp(rows);

      const response = await request(app)
        .get("/export?startDate=2024-01-01&status=completed&format=csv")
        .set("x-test-user-id", "user-1")
        .expect(200);

      expect(response.headers["content-type"]).toContain("text/csv");
      expect(response.text).toContain(
        "id,user_id,amount,currency,type,status,created_at,description",
      );
      expect(response.text).toContain('"hello,""world""\nnext"');
      expect(createQueryStream).toHaveBeenCalledWith(
        expect.stringContaining("WHERE"),
        expect.any(Array),
      );
      expect(client.release).toHaveBeenCalled();
    });
  });

  describe("JSON export", () => {
    it("streams JSON exports and returns a 500 response when the database fails", async () => {
      const { app, db } = buildApp([{ id: 2, status: "pending" }]);

      const response = await request(app)
        .get("/export?format=json")
        .set("x-test-user-id", "user-1")
        .expect(200);

      expect(response.headers["content-type"]).toContain("application/json");
      expect(response.text).toContain('"id": 2');
      expect(response.text).toContain('"status": "pending"');

      db.connect.mockRejectedValueOnce(new Error("db unavailable"));
      const errorResponse = await request(app)
        .get("/export?format=json")
        .set("x-test-user-id", "user-1")
        .expect(500);

      expect(errorResponse.body).toEqual({ error: "Export failed" });
    });
  });

  describe("PDF export", () => {
    it("streams a PDF export with the correct content type", async () => {
      const rows = [
        {
          id: 1,
          user_id: "user-1",
          amount: 100,
          currency: "USD",
          type: "deposit",
          status: "completed",
          created_at: "2024-01-02T03:04:05.000Z",
          description: "test",
        },
      ];
      const { app } = buildApp(rows);

      const response = await request(app)
        .get("/export?format=pdf")
        .set("x-test-user-id", "user-1")
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect(response.headers["content-type"]).toBe("application/pdf");
      expect(response.headers["content-disposition"]).toContain(
        "transactions-",
      );
      // PDF files start with the "%PDF-" magic header
      expect((response.body as Buffer).slice(0, 5).toString()).toBe("%PDF-");
    });

    it("renders a valid PDF even with zero rows", async () => {
      const { app } = buildApp([]);

      const response = await request(app)
        .get("/export?format=pdf")
        .set("x-test-user-id", "user-1")
        .buffer(true)
        .parse((res, callback) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200);

      expect((response.body as Buffer).slice(0, 5).toString()).toBe("%PDF-");
    });
  });
});
