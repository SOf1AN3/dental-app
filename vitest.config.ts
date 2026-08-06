// CommonJS-style config: this package has no "type": "module", so ESM
// syntax here would trigger Vite's native config loader warning.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { join } = require("node:path");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { defineConfig } = require("vitest/config");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const dotenv = require("dotenv");

const loadedEnv = dotenv.config().parsed ?? {};

module.exports = defineConfig({
  resolve: {
    alias: {
      "@": join(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["node_modules", ".next"],
    env: loadedEnv,
  },
});
