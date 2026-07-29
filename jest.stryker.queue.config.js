const baseConfig = require("./jest.config");

module.exports = {
  ...baseConfig,
  projects: undefined,
  testMatch: [
    "<rootDir>/src/tests/queue/syncWorker.test.ts",
    "<rootDir>/src/tests/queue/syncQueue.retention.test.ts",
    "<rootDir>/tests/queue/syncWorker.nats.test.ts",
  ],
};
