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
      testMatch: [
        "**/__tests__/**/*.ts",
        "**/?(*.)+(spec|test).ts",
      ],
      // Exclude the frontend JS tests from this project
      testPathIgnorePatterns: [
        "/node_modules/",
        "<rootDir>/src/tests/frontend/",
      ],
      transform: {
        "^.+\\.ts$": [
          "ts-jest",
          { diagnostics: false },
        ],
      },
      moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
    },
    {
      displayName: "frontend",
      // No preset — plain JS, no TypeScript compilation needed
      testEnvironment: "jsdom",
      setupFiles: ["<rootDir>/tests/jest.setup.ts"],
      roots: ["<rootDir>/src/tests/frontend"],
      testMatch: [
        "**/?(*.)+(spec|test).js",
      ],
      // The calculator module is plain CommonJS — no transpilation required.
      // An empty transform map tells Jest to load JS files as-is via Node.
      transform: {},
      moduleFileExtensions: ["js", "json", "node"],
    },
  ],
  // Coverage collected from both projects
  collectCoverageFrom: [
    "src/**/*.ts",
    "src/tests/frontend/**/*.js",
    "!src/**/*.d.ts",
    "!src/index.ts",
    "!src/**/__tests__/**",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "text-summary", "lcov", "html", "json-summary"],
  coverageThreshold: {
    global: {
      branches: 15,
      functions: 25,
      lines: 20,
      statements: 20,
    },
  },
  verbose: true,
};
