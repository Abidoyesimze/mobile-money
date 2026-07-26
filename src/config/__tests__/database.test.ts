type MockQueryResult = { rows: Array<Record<string, unknown>> };

class MockPool {
  public query = jest.fn<Promise<MockQueryResult>, [any, any?]>();
  public connect = jest.fn<Promise<any>, []>();
  public end = jest.fn<Promise<void>, []>();
  public on = jest.fn();

  emit(event: string, ...args: any[]): boolean {
    return true;
  }
}

const poolInstances: MockPool[] = [];
const MockPoolCtor = jest.fn().mockImplementation(() => {
  const instance = new MockPool();
  poolInstances.push(instance);
  return instance;
});

jest.mock("pg", () => ({
  Pool: MockPoolCtor,
}));

describe("database pool reconnect handling", () => {
  beforeEach(() => {
    jest.resetModules();
    poolInstances.length = 0;
    MockPoolCtor.mockClear();
  });

  it("recreates the pool and retries after a database disconnect", async () => {
    const firstPool = new MockPool();
    const secondPool = new MockPool();

    firstPool.query.mockRejectedValueOnce(new Error("connection lost"));
    secondPool.query.mockResolvedValue({ rows: [{ ok: true }] });

    MockPoolCtor
      .mockImplementationOnce(() => firstPool as any)
      .mockImplementationOnce(() => secondPool as any);

    const { queryWrite } = await import("../database");

    firstPool.emit("error", new Error("connection lost"));

    const result = await queryWrite("SELECT 1");

    expect(result.rows).toEqual([{ ok: true }]);
    expect(MockPoolCtor).toHaveBeenCalledTimes(2);
  });
});
