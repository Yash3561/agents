import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Separate from vitest.config.ts on purpose: these tests hit a real LLM
// (real cost, real latency, nondeterministic output) and must never be
// picked up by `npm test` / `npm run test:unit` / `npm run test:coverage`.
// See tests/evals/README.md for how to run this for real.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    include: ["tests/evals/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
