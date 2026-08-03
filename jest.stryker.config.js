const baseConfig = require("./jest.config");

module.exports = {
  ...baseConfig,
  testMatch: [
    "<rootDir>/tests/transactions.test.ts",
  ],
};
