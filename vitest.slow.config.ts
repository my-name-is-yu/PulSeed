import { defineConfig } from "vitest/config";
import {
  sharedCoverage,
  sharedResolve,
  slowInclude,
} from "./vitest.patterns.js";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: slowInclude,
    coverage: sharedCoverage,
    testTimeout: 180_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
  resolve: sharedResolve,
});
