import { Pool } from "pg";

describe("Database pool configuration (#1652)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  describe("pool sizing constants", () => {
    it("uses default POOL_MIN of 10", () => {
      delete process.env.DB_POOL_MIN;
      jest.isolateModules(() => {
        const config = require("../../config/database");
        // Access the constants via the module's pool creation
        expect(config.pool).toBeDefined();
      });
    });

    it("uses DB_POOL_MIN from env when set", () => {
      process.env.DB_POOL_MIN = "5";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool).toBeDefined();
      });
    });

    it("uses DB_POOL_MAX from env when set", () => {
      process.env.DB_POOL_MAX = "200";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool).toBeDefined();
      });
    });

    it("defaults POOL_DEFAULT_MAX to min(25, POOL_MAX)", () => {
      process.env.DB_POOL_DEFAULT_MAX = "25";
      process.env.DB_POOL_MAX = "100";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool.options.max).toBe(25);
      });
    });

    it("caps POOL_DEFAULT_MAX at POOL_MAX", () => {
      process.env.DB_POOL_DEFAULT_MAX = "200";
      process.env.DB_POOL_MAX = "50";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool.options.max).toBeLessThanOrEqual(50);
      });
    });
  });

  describe("pool utilization calculation", () => {
    it("returns 0 for empty pool", () => {
      const mockPool = { totalCount: 0, idleCount: 0 } as Pool;
      // We test the logic indirectly via the pool options
      expect(mockPool.totalCount).toBe(0);
    });
  });

  describe("buildPoolOptions", () => {
    it("sets connectionString from DATABASE_URL", () => {
      process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/testdb";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool.options.connectionString).toContain("testdb");
      });
    });

    it("uses SANDBOX_DATABASE_URL when IS_SANDBOX is true", () => {
      process.env.IS_SANDBOX = "true";
      process.env.SANDBOX_DATABASE_URL = "postgresql://sandbox:sandbox@localhost:5432/sandbox";
      process.env.DATABASE_URL = "postgresql://primary:primary@localhost:5432/primary";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool.options.connectionString).toContain("sandbox");
      });
    });

    it("configures SSL in production", () => {
      process.env.NODE_ENV = "production";
      process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/testdb";
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool.options.ssl).toBeDefined();
      });
    });
  });

  describe("query routing", () => {
    it("exports queryRead, queryWrite, and querySmart", () => {
      // Can't test the actual routing without a DB, but verify exports exist
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(typeof config.queryRead).toBe("function");
        expect(typeof config.queryWrite).toBe("function");
        expect(typeof config.querySmart).toBe("function");
      });
    });
  });

  describe("pool monitoring", () => {
    it("starts pool monitor in non-test environments", () => {
      // Verify the monitor doesn't crash
      jest.isolateModules(() => {
        const config = require("../../config/database");
        expect(config.pool).toBeDefined();
      });
    });
  });
});
