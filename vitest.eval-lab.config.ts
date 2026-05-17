import { defineConfig } from "vitest/config";
import {
  sharedCoverage,
  sharedResolve,
} from "./vitest.patterns.js";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: ["tests/eval-lab/**/*.test.ts"],
    coverage: sharedCoverage,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
  resolve: sharedResolve,
});
