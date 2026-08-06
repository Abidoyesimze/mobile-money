import express from "express";
import request from "supertest";
import { PassThrough } from "stream";
import { createExportRoutes } from "../export";

describe("createExportRoutes", () => {
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

    const db = {
      connect: jest.fn().mockResolvedValue(client),
    };

    const createQueryStream = jest.fn((text: string, values: unknown[]) => ({ text, values }));

    const app = express();
    app.use((req, _res, next) => {
      (req as any).user = { id: "user-1" };
      next();
    });
    app.use(
      createExportRoutes({
        db: db as any,
        createQueryStream: createQueryStream as any,
      }),
    );

    const response = await request(app)
      .get("/export?startDate=2024-01-01&status=completed&format=csv")
      .expect(200);

    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.text).toContain("id,user_id,amount,currency,type,status,created_at,description");
    expect(response.text).toContain('"hello,""world""\nnext"');
    expect(createQueryStream).toHaveBeenCalledWith(
      expect.stringContaining("WHERE"),
      expect.any(Array),
    );
    expect(client.release).toHaveBeenCalled();
  });

  it("streams JSON exports and returns a 500 response when the database fails", async () => {
    const stream = new PassThrough({ objectMode: true });
    const client = {
      release: jest.fn(),
      query: jest.fn(() => {
        process.nextTick(() => {
          stream.write({ id: 2, status: "pending" });
          stream.end();
        });
        return stream;
      }),
    };

    const db = {
      connect: jest.fn().mockResolvedValue(client),
    };

    const app = express();
    app.use(
      createExportRoutes({
        db: db as any,
        createQueryStream: jest.fn((text: string, values: unknown[]) => ({ text, values })) as any,
      }),
    );

    const response = await request(app).get("/export?format=json").expect(200);

    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.text).toContain('"id": 2');
    expect(response.text).toContain('"status": "pending"');

    db.connect.mockRejectedValueOnce(new Error("db unavailable"));
    const errorResponse = await request(app).get("/export?format=json").expect(500);

    expect(errorResponse.body).toEqual({ error: "Export failed" });
  });
});
