module.exports = {
  // Run two project configs in one pass:
  //   1. "backend"  — all existing TypeScript tests, node environment
  //   2. "frontend" — JS calculator tests, jsdom environment
  projects: [
    {
      displayName: "backend",
      preset: "ts-jest",
      testEnvironment: "node",
      setupFiles: ["<rootDir>/tests/jest.setup.ts"],
      roots: ["<rootDir>/src", "<rootDir>/tests"],
      testMatch: ["**/__tests__/**/*.ts", "**/?(*.)+(spec|test).ts"],
      // Exclude the frontend JS tests from this project
      testPathIgnorePatterns: [
        "/node_modules/",
        "<rootDir>/src/tests/frontend/",
      ],
      transform: {
        "^.+\\.ts$": ["ts-jest", { diagnostics: false }],
      },
      moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
      // Mirrors the (otherwise-dead, since `projects` doesn't inherit
      // top-level options) mapper below — lets `jest.mock("../foo.js")`
      // resolve to the real "../foo.ts" source file.
      moduleNameMapper: {
        "^(\\.\\.?\\/.+)\\.js$": "$1",
      },
    },
    {
      displayName: "frontend",
      // No preset — plain JS, no TypeScript compilation needed
      testEnvironment: "jsdom",
      setupFiles: ["<rootDir>/tests/jest.setup.ts"],
      roots: ["<rootDir>/src/tests/frontend"],
      testMatch: ["**/?(*.)+(spec|test).js"],
      // The calculator module is plain CommonJS — no transpilation required.
      // An empty transform map tells Jest to load JS files as-is via Node.
      transform: {},
      moduleFileExtensions: ["js", "json", "node"],
    },
  ],
  // Coverage collected from both projects
  preset: "ts-jest",
  testEnvironment: "node",
  setupFilesAfterEnv: ["<rootDir>/tests/jest.setup.ts"],
  roots: ["<rootDir>/src", "<rootDir>/tests"],
  testMatch: ["**/__tests__/**/*.ts", "**/?(*.)+(spec|test).ts"],
  testPathIgnorePatterns: ["/node_modules/", "/tests/pact/", "/tests/e2e/"],
  testTimeout: 30000,
  moduleNameMapper: {
    "^(\\.\\.?\\/.+)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": ["ts-jest", { diagnostics: false }],
  },
  collectCoverageFrom: [
    "src/**/*.ts",
    "src/tests/frontend/**/*.js",
    "!src/**/*.d.ts",
    "!src/index.ts",
    "!src/**/__tests__/**",
    "!src/services/providerSettlementService.ts",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary", "lcov", "html", "json-summary"],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
  verbose: true,
  maxWorkers: "50%",
};
