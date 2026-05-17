import { defineConfig } from "vitest/config";
import {
  evalLabInclude,
  sharedCoverage,
  sharedResolve,
} from "./vitest.patterns.js";

export default defineConfig({
  test: {
    globals: true,
    root: ".",
    include: evalLabInclude,
    coverage: sharedCoverage,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    maxWorkers: 1,
  },
  resolve: sharedResolve,
});
